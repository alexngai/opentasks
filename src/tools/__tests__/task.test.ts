/**
 * Tests for Task Tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { task } from '../task.js'
import type { ProviderAwareStore } from '../../graph/provider-store.js'
import type { Node } from '../../schema/index.js'

describe('task tool', () => {
  let mockStore: ProviderAwareStore

  const sampleNode: Node = {
    id: 'x-task1',
    uuid: 'uuid-1',
    type: 'external',
    title: 'Test Task',
    priority: 1,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  beforeEach(() => {
    mockStore = {
      taskTransition: vi.fn().mockResolvedValue({
        node: { ...sampleNode, title: 'Started Task' },
        provider: 'beads',
        action: 'start',
      }),
      taskReady: vi.fn().mockResolvedValue([sampleNode]),
      taskAssign: vi.fn().mockResolvedValue(sampleNode),
      taskValidActions: vi.fn().mockResolvedValue(['start', 'complete', 'close']),
    } as unknown as ProviderAwareStore
  })

  describe('operation validation', () => {
    it('should error when no operation specified', async () => {
      const result = await task(mockStore, {})
      expect(result.success).toBe(false)
      expect(result.error).toContain('No operation specified')
    })

    it('should error when multiple operations specified', async () => {
      const result = await task(mockStore, {
        transition: { id: 'x-task1', action: 'start' },
        ready: {},
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Multiple operations')
    })
  })

  describe('transition', () => {
    it('should transition a task', async () => {
      const result = await task(mockStore, {
        transition: { id: 'x-task1', action: 'start' },
      })

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data!.type).toBe('transition')
      if (result.data!.type === 'transition') {
        expect(result.data!.provider).toBe('beads')
        expect(result.data!.action).toBe('start')
        expect(result.data!.node.id).toBe('x-task1')
      }

      expect(mockStore.taskTransition).toHaveBeenCalledWith('x-task1', 'start')
    })

    it('should reject invalid action', async () => {
      const result = await task(mockStore, {
        transition: { id: 'x-task1', action: 'invalid' as any },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid action')
    })

    it('should require id', async () => {
      const result = await task(mockStore, {
        transition: { id: '', action: 'start' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing required parameter: id')
    })

    it('should handle provider errors gracefully', async () => {
      vi.mocked(mockStore.taskTransition).mockRejectedValue(
        new Error('Provider beads does not support task operations')
      )

      const result = await task(mockStore, {
        transition: { id: 'x-task1', action: 'start' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('does not support task operations')
    })

    it('should support all valid actions', async () => {
      for (const action of ['start', 'complete', 'block', 'reopen', 'close'] as const) {
        vi.mocked(mockStore.taskTransition).mockResolvedValue({
          node: sampleNode,
          provider: 'beads',
          action,
        })

        const result = await task(mockStore, {
          transition: { id: 'x-task1', action },
        })

        expect(result.success).toBe(true)
      }
    })
  })

  describe('ready', () => {
    it('should return ready tasks', async () => {
      const result = await task(mockStore, { ready: {} })

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data!.type).toBe('ready')
      if (result.data!.type === 'ready') {
        expect(result.data!.items).toHaveLength(1)
        expect(result.data!.items[0].id).toBe('x-task1')
        expect(result.data!.total).toBe(1)
      }
    })

    it('should forward filter options', async () => {
      await task(mockStore, {
        ready: { providers: ['beads'], limit: 5, tags: ['urgent'] },
      })

      expect(mockStore.taskReady).toHaveBeenCalledWith({
        providers: ['beads'],
        limit: 5,
        tags: ['urgent'],
        priority: undefined,
        assignee: undefined,
      })
    })

    it('should return empty list when no ready tasks', async () => {
      vi.mocked(mockStore.taskReady).mockResolvedValue([])

      const result = await task(mockStore, { ready: {} })

      expect(result.success).toBe(true)
      if (result.data!.type === 'ready') {
        expect(result.data!.items).toHaveLength(0)
        expect(result.data!.total).toBe(0)
      }
    })
  })

  describe('assign', () => {
    it('should assign a task', async () => {
      const result = await task(mockStore, {
        assign: { id: 'x-task1', assignee: 'alice' },
      })

      expect(result.success).toBe(true)
      expect(result.data!.type).toBe('assign')
      expect(mockStore.taskAssign).toHaveBeenCalledWith('x-task1', 'alice')
    })

    it('should require id', async () => {
      const result = await task(mockStore, {
        assign: { id: '', assignee: 'alice' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing required parameter: id')
    })

    it('should require assignee', async () => {
      const result = await task(mockStore, {
        assign: { id: 'x-task1', assignee: '' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing required parameter: assignee')
    })
  })

  describe('validActions', () => {
    it('should return valid actions', async () => {
      const result = await task(mockStore, {
        validActions: { id: 'x-task1' },
      })

      expect(result.success).toBe(true)
      expect(result.data!.type).toBe('validActions')
      if (result.data!.type === 'validActions') {
        expect(result.data!.actions).toEqual(['start', 'complete', 'close'])
      }

      expect(mockStore.taskValidActions).toHaveBeenCalledWith('x-task1')
    })

    it('should require id', async () => {
      const result = await task(mockStore, {
        validActions: { id: '' },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing required parameter: id')
    })
  })
})
