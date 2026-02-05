/**
 * Tests for Link Tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { link } from '../link.js'
import type { GraphStore } from '../../graph/store.js'
import type { LinkParams } from '../types.js'

describe('link tool', () => {
  let mockStore: GraphStore

  // Sample nodes
  const specNode = {
    id: 's-test1',
    type: 'spec' as const,
    title: 'Test Spec',
  }

  const issueNode = {
    id: 'i-test1',
    type: 'issue' as const,
    title: 'Test Issue',
  }

  beforeEach(() => {
    const nodes = new Map<string, unknown>()
    nodes.set(specNode.id, specNode)
    nodes.set(issueNode.id, issueNode)

    const edges = new Map<string, unknown>()
    let edgeCounter = 0

    mockStore = {
      getNode: vi.fn().mockImplementation(async (id: string) => {
        return nodes.get(id) || null
      }),
      createEdge: vi.fn().mockImplementation(async (input) => {
        const edge = {
          id: `x-edge${++edgeCounter}`,
          fromId: input.fromId,
          toId: input.toId,
          type: input.type,
          metadata: input.metadata,
          created_at: new Date().toISOString(),
        }
        edges.set(edge.id, edge)
        return edge
      }),
      deleteEdge: vi.fn().mockImplementation(async (id: string) => {
        edges.delete(id)
      }),
      query: {
        edges: vi.fn().mockImplementation(async ({ fromId, type }) => {
          return Array.from(edges.values()).filter(
            (e: any) => e.fromId === fromId && (!type || e.type === type)
          )
        }),
      },
    } as unknown as GraphStore
  })

  describe('creating edges', () => {
    it('should create edge between two existing nodes', async () => {
      const params: LinkParams = {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(true)
      expect(result.edgeId).toBeDefined()
      expect(mockStore.createEdge).toHaveBeenCalledWith({
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
        metadata: undefined,
      })
    })

    it('should return edgeId on successful creation', async () => {
      const params: LinkParams = {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'blocks',
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(true)
      expect(result.edgeId).toMatch(/^x-edge/)
    })

    it('should pass metadata to edge', async () => {
      const params: LinkParams = {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'references',
        metadata: { reason: 'related work' },
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(true)
      expect(mockStore.createEdge).toHaveBeenCalledWith({
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'references',
        metadata: { reason: 'related work' },
      })
    })

    it('should handle all edge types', async () => {
      const edgeTypes = [
        'blocks',
        'implements',
        'references',
        'depends-on',
        'discovered-from',
        'related',
      ] as const

      for (const type of edgeTypes) {
        const result = await link(mockStore, {
          fromId: 'i-test1',
          toId: 's-test1',
          type,
        })

        expect(result.success).toBe(true)
      }
    })
  })

  describe('node validation', () => {
    it('should validate local fromId exists', async () => {
      const params: LinkParams = {
        fromId: 'i-nonexistent',
        toId: 's-test1',
        type: 'implements',
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Node not found: i-nonexistent')
    })

    it('should validate local toId exists', async () => {
      const params: LinkParams = {
        fromId: 'i-test1',
        toId: 's-nonexistent',
        type: 'implements',
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Node not found: s-nonexistent')
    })

    it('should skip validation for provider URIs (fromId)', async () => {
      const params: LinkParams = {
        fromId: 'beads://./bd-123',
        toId: 's-test1',
        type: 'implements',
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(true)
      expect(mockStore.getNode).not.toHaveBeenCalledWith('beads://./bd-123')
    })

    it('should skip validation for provider URIs (toId)', async () => {
      const params: LinkParams = {
        fromId: 'i-test1',
        toId: 'jira://PROJ-123',
        type: 'references',
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(true)
      expect(mockStore.getNode).not.toHaveBeenCalledWith('jira://PROJ-123')
    })

    it('should skip validation for claude:// URIs', async () => {
      const params: LinkParams = {
        fromId: 'claude://current/t-abc',
        toId: 's-test1',
        type: 'implements',
      }

      const result = await link(mockStore, params)

      expect(result.success).toBe(true)
    })
  })

  describe('removing edges', () => {
    it('should remove existing edge', async () => {
      // First create an edge
      await link(mockStore, {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
      })

      // Then remove it
      const result = await link(mockStore, {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
        remove: true,
      })

      expect(result.success).toBe(true)
      expect(mockStore.deleteEdge).toHaveBeenCalled()
    })

    it('should return success when removing non-existent edge (idempotent)', async () => {
      const result = await link(mockStore, {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
        remove: true,
      })

      expect(result.success).toBe(true)
      expect(mockStore.deleteEdge).not.toHaveBeenCalled()
    })
  })

  describe('parameter validation', () => {
    it('should return error when fromId is missing', async () => {
      const result = await link(mockStore, {
        fromId: '',
        toId: 's-test1',
        type: 'implements',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('fromId')
    })

    it('should return error when toId is missing', async () => {
      const result = await link(mockStore, {
        fromId: 'i-test1',
        toId: '',
        type: 'implements',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('toId')
    })

    it('should return error when type is missing', async () => {
      const result = await link(mockStore, {
        fromId: 'i-test1',
        toId: 's-test1',
        type: '' as any,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('type')
    })
  })

  describe('error handling', () => {
    it('should catch and return cycle detection errors', async () => {
      mockStore.createEdge = vi.fn().mockRejectedValue(new Error('Would create a cycle'))

      const result = await link(mockStore, {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'blocks',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('cycle')
    })

    it('should catch and return other errors', async () => {
      mockStore.createEdge = vi.fn().mockRejectedValue(new Error('Database error'))

      const result = await link(mockStore, {
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database error')
    })
  })
})
