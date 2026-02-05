/**
 * Tests for Annotate Tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { annotate } from '../annotate.js'
import type { GraphStore } from '../../graph/store.js'
import type { AnnotateParams } from '../types.js'

describe('annotate tool', () => {
  let mockStore: GraphStore
  let nodeCounter: number
  let edgeCounter: number

  // Sample nodes
  const specNode = {
    id: 's-test1',
    type: 'spec' as const,
    title: 'Test Spec',
    content: 'This is test content',
  }

  const issueNode = {
    id: 'i-test1',
    type: 'issue' as const,
    title: 'Test Issue',
  }

  const feedbackNode = {
    id: 'f-test1',
    type: 'feedback' as const,
    title: 'Test Feedback',
    targetId: 's-test1',
    feedback_type: 'comment' as const,
    resolved: false,
    dismissed: false,
  }

  const resolvedFeedback = {
    id: 'f-resolved',
    type: 'feedback' as const,
    title: 'Resolved Feedback',
    targetId: 's-test1',
    feedback_type: 'comment' as const,
    resolved: true,
    dismissed: false,
  }

  const dismissedFeedback = {
    id: 'f-dismissed',
    type: 'feedback' as const,
    title: 'Dismissed Feedback',
    targetId: 's-test1',
    feedback_type: 'comment' as const,
    resolved: false,
    dismissed: true,
  }

  beforeEach(() => {
    nodeCounter = 0
    edgeCounter = 0

    const nodes = new Map<string, any>()
    nodes.set(specNode.id, { ...specNode })
    nodes.set(issueNode.id, { ...issueNode })
    nodes.set(feedbackNode.id, { ...feedbackNode })
    nodes.set(resolvedFeedback.id, { ...resolvedFeedback })
    nodes.set(dismissedFeedback.id, { ...dismissedFeedback })

    mockStore = {
      getNode: vi.fn().mockImplementation(async (id: string) => {
        return nodes.get(id) || null
      }),
      createNode: vi.fn().mockImplementation(async (input) => {
        const node = {
          ...input,
          id: `f-new${++nodeCounter}`,
          uuid: `uuid-${nodeCounter}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        nodes.set(node.id, node)
        return node
      }),
      updateNode: vi.fn().mockImplementation(async (id: string, updates) => {
        const existing = nodes.get(id)
        if (!existing) throw new Error('Node not found')
        const updated = { ...existing, ...updates }
        nodes.set(id, updated)
        return updated
      }),
      createEdge: vi.fn().mockImplementation(async (input) => {
        return {
          id: `x-edge${++edgeCounter}`,
          ...input,
          created_at: new Date().toISOString(),
        }
      }),
    } as unknown as GraphStore
  })

  describe('operation validation', () => {
    it('should error when targetId is missing', async () => {
      const result = await annotate(mockStore, {
        targetId: '',
        create: { content: 'Test feedback' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('targetId')
    })

    it('should error when no operation specified', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('No operation specified')
    })

    it('should error when multiple operations specified', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: 'Test' },
        resolve: 'f-test1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Multiple operations specified')
    })
  })

  describe('create feedback', () => {
    it('should create feedback with content', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: 'This is test feedback' },
      })

      expect(result.success).toBe(true)
      expect(result.feedbackId).toBeDefined()
      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'feedback',
          content: 'This is test feedback',
          target_id: 's-test1',
          feedback_type: 'comment',
        })
      )
    })

    it('should create feedback with line anchor', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        create: {
          content: 'Line-specific feedback',
          anchor: { line: 10 },
        },
      })

      expect(result.success).toBe(true)
      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          target_anchor: { line: 10, anchor_status: 'valid' },
        })
      )
    })

    it('should create feedback with text anchor', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        create: {
          content: 'Text-anchored feedback',
          anchor: { text: 'important section' },
        },
      })

      expect(result.success).toBe(true)
      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          target_anchor: { text: 'important section', anchor_status: 'valid' },
        })
      )
    })

    it('should create feedback without anchor', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: 'General feedback' },
      })

      expect(result.success).toBe(true)
      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          target_anchor: undefined,
        })
      )
    })

    it('should set feedback_type (defaults to comment)', async () => {
      // Test default
      await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: 'Default type' },
      })

      expect(mockStore.createNode).toHaveBeenLastCalledWith(
        expect.objectContaining({ feedback_type: 'comment' })
      )

      // Test explicit type
      await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: 'Suggestion', type: 'suggestion' },
      })

      expect(mockStore.createNode).toHaveBeenLastCalledWith(
        expect.objectContaining({ feedback_type: 'suggestion' })
      )
    })

    it('should link feedback to fromId when provided', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        fromId: 'i-test1',
        create: { content: 'Feedback from issue' },
      })

      expect(result.success).toBe(true)
      expect(mockStore.createEdge).toHaveBeenCalledWith({
        from_id: 'i-test1',
        to_id: expect.stringMatching(/^f-/),
        type: 'discovered-from',
        metadata: undefined,
      })
    })

    it('should truncate long content for title', async () => {
      const longContent = 'A'.repeat(100)
      await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: longContent },
      })

      const createCall = (mockStore.createNode as any).mock.calls[0][0]
      expect(createCall.title.length).toBeLessThanOrEqual(50)
      expect(createCall.title).toContain('...')
    })

    it('should error when target not found', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-nonexistent',
        create: { content: 'Test' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Target node not found')
    })

    it('should error when content is missing', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: '' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('content')
    })
  })

  describe('resolve feedback', () => {
    it('should resolve existing feedback', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        resolve: 'f-test1',
      })

      expect(result.success).toBe(true)
      expect(result.feedbackId).toBe('f-test1')
      expect(mockStore.updateNode).toHaveBeenCalledWith('f-test1', { resolved: true })
    })

    it('should error when feedback not found', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        resolve: 'f-nonexistent',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Feedback not found')
    })

    it('should error when node is not feedback', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        resolve: 's-test1', // spec, not feedback
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not feedback')
    })
  })

  describe('dismiss feedback', () => {
    it('should dismiss existing feedback', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        dismiss: 'f-test1',
      })

      expect(result.success).toBe(true)
      expect(result.feedbackId).toBe('f-test1')
      expect(mockStore.updateNode).toHaveBeenCalledWith('f-test1', { dismissed: true })
    })

    it('should error when feedback not found', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        dismiss: 'f-nonexistent',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Feedback not found')
    })
  })

  describe('reopen feedback', () => {
    it('should reopen resolved feedback', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        reopen: 'f-resolved',
      })

      expect(result.success).toBe(true)
      expect(result.feedbackId).toBe('f-resolved')
      expect(mockStore.updateNode).toHaveBeenCalledWith('f-resolved', {
        resolved: false,
        dismissed: false,
      })
    })

    it('should reopen dismissed feedback', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        reopen: 'f-dismissed',
      })

      expect(result.success).toBe(true)
      expect(result.feedbackId).toBe('f-dismissed')
      expect(mockStore.updateNode).toHaveBeenCalledWith('f-dismissed', {
        resolved: false,
        dismissed: false,
      })
    })

    it('should error when feedback not found', async () => {
      const result = await annotate(mockStore, {
        targetId: 's-test1',
        reopen: 'f-nonexistent',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Feedback not found')
    })
  })

  describe('error handling', () => {
    it('should catch and return store errors', async () => {
      mockStore.createNode = vi.fn().mockRejectedValue(new Error('Database error'))

      const result = await annotate(mockStore, {
        targetId: 's-test1',
        create: { content: 'Test' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database error')
    })
  })
})
