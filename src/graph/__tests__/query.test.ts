/**
 * Tests for Query Engine
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueryEngine, type QueryEngine } from '../query.js'
import type { Storage } from '../../storage/interface.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'
import type { EdgeType } from '../../schema/edges.js'

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockStorage(): Storage {
  return {
    createNode: vi.fn(),
    getNode: vi.fn(),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
    queryNodes: vi.fn().mockResolvedValue([]),
    createEdge: vi.fn(),
    getEdge: vi.fn(),
    deleteEdge: vi.fn(),
    getEdgesFrom: vi.fn().mockResolvedValue([]),
    getEdgesTo: vi.fn().mockResolvedValue([]),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    getTags: vi.fn().mockResolvedValue([]),
    getTagsForNodes: vi.fn().mockResolvedValue(new Map()),
    getNodesByTag: vi.fn().mockResolvedValue([]),
    getReady: vi.fn().mockResolvedValue([]),
    runInTransaction: vi.fn(),
    markDirty: vi.fn(),
    getDirtyNodes: vi.fn().mockResolvedValue([]),
    clearDirty: vi.fn(),
    close: vi.fn(),
  }
}

function createContext(id: string, title: string, overrides: Partial<StoredNode> = {}): StoredNode {
  return {
    id,
    uuid: `uuid-${id}`,
    type: 'context',
    title,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    archived: false,
    ...overrides,
  }
}

function createTask(
  id: string,
  title: string,
  status: string = 'open',
  overrides: Partial<StoredNode> = {}
): StoredNode {
  return {
    id,
    uuid: `uuid-${id}`,
    type: 'task',
    title,
    status,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    archived: false,
    ...overrides,
  }
}

function createFeedback(
  id: string,
  targetId: string,
  overrides: Partial<StoredNode> = {}
): StoredNode {
  return {
    id,
    uuid: `uuid-${id}`,
    type: 'feedback',
    title: 'Feedback',
    target_id: targetId,
    feedback_type: 'comment',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    archived: false,
    resolved: false,
    dismissed: false,
    ...overrides,
  }
}

function createEdge(
  id: string,
  fromId: string,
  toId: string,
  type: EdgeType
): StoredEdge {
  return {
    id,
    uuid: `uuid-${id}`,
    from_id: fromId,
    to_id: toId,
    type,
    created_at: '2024-01-01T00:00:00Z',
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('QueryEngine', () => {
  let storage: Storage
  let engine: QueryEngine

  beforeEach(() => {
    storage = createMockStorage()
    engine = createQueryEngine(storage)
  })

  describe('nodes()', () => {
    it('should query nodes with filter', async () => {
      const context = createContext('c-abc1', 'Test Context')
      vi.mocked(storage.queryNodes).mockResolvedValue([context])

      const result = await engine.nodes({ type: 'context' })

      expect(storage.queryNodes).toHaveBeenCalledWith({
        type: 'context',
        status: undefined,
        tags: undefined,
        parent_id: undefined,
        archived: undefined,
        search: undefined,
        limit: undefined,
        offset: undefined,
      })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('c-abc1')
    })

    it('should filter out invalid nodes', async () => {
      const validContext = createContext('c-abc1', 'Test Context')
      const invalidNode = { id: 'invalid', type: 'unknown' } as StoredNode
      vi.mocked(storage.queryNodes).mockResolvedValue([validContext, invalidNode])

      const result = await engine.nodes({})

      // Only valid context should be returned
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('c-abc1')
    })

    it('should handle archived filter', async () => {
      vi.mocked(storage.queryNodes).mockResolvedValue([])

      await engine.nodes({ archived: false })

      expect(storage.queryNodes).toHaveBeenCalledWith(
        expect.objectContaining({ archived: false })
      )
    })

    it('should convert null archived to undefined', async () => {
      vi.mocked(storage.queryNodes).mockResolvedValue([])

      await engine.nodes({ archived: null })

      expect(storage.queryNodes).toHaveBeenCalledWith(
        expect.objectContaining({ archived: undefined })
      )
    })
  })

  describe('edges()', () => {
    it('should query edges from a node', async () => {
      const edge = createEdge('x-abc1', 'c-a', 'c-b', 'references')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])

      const result = await engine.edges({ from_id: 'c-a' })

      expect(storage.getEdgesFrom).toHaveBeenCalledWith('c-a', undefined)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('x-abc1')
    })

    it('should query edges to a node', async () => {
      const edge = createEdge('x-abc1', 'c-a', 'c-b', 'references')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])

      const result = await engine.edges({ to_id: 'c-b' })

      expect(storage.getEdgesTo).toHaveBeenCalledWith('c-b', undefined)
      expect(result).toHaveLength(1)
    })

    it('should return empty when no filter specified', async () => {
      const result = await engine.edges({})
      expect(result).toHaveLength(0)
    })

    it('should apply pagination', async () => {
      const edges = [
        createEdge('x-1', 'c-a', 'c-b', 'references'),
        createEdge('x-2', 'c-a', 'c-c', 'references'),
        createEdge('x-3', 'c-a', 'c-d', 'references'),
      ]
      vi.mocked(storage.getEdgesFrom).mockResolvedValue(edges)

      const result = await engine.edges({ from_id: 'c-a', offset: 1, limit: 1 })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('x-2')
    })
  })

  describe('edgesFrom()', () => {
    it('should get edges from a node', async () => {
      const edge = createEdge('x-abc1', 'c-a', 'c-b', 'blocks')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])

      const result = await engine.edgesFrom('c-a', 'blocks')

      expect(storage.getEdgesFrom).toHaveBeenCalledWith('c-a', 'blocks')
      expect(result).toHaveLength(1)
    })
  })

  describe('edgesTo()', () => {
    it('should get edges to a node', async () => {
      const edge = createEdge('x-abc1', 'c-a', 'c-b', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])

      const result = await engine.edgesTo('c-b', 'blocks')

      expect(storage.getEdgesTo).toHaveBeenCalledWith('c-b', 'blocks')
      expect(result).toHaveLength(1)
    })
  })

  describe('edgesFor()', () => {
    it('should get all edges for a node (both directions)', async () => {
      const fromEdge = createEdge('x-1', 'c-a', 'c-b', 'blocks')
      const toEdge = createEdge('x-2', 'c-c', 'c-a', 'references')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([fromEdge])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([toEdge])

      const result = await engine.edgesFor('c-a')

      expect(result).toHaveLength(2)
      expect(result.map((e) => e.id).sort()).toEqual(['x-1', 'x-2'])
    })

    it('should deduplicate edges', async () => {
      const edge = createEdge('x-1', 'c-a', 'c-a', 'references') // self-reference
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])

      const result = await engine.edgesFor('c-a')

      expect(result).toHaveLength(1)
    })
  })

  describe('blockers()', () => {
    it('should get direct blockers', async () => {
      const blocker = createTask('t-blocker', 'Blocking Task', 'open')
      const edge = createEdge('x-1', 't-blocker', 't-blocked', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(blocker)

      const result = await engine.blockers('t-blocked')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-blocker')
    })

    it('should filter out inactive blockers by default', async () => {
      const closedBlocker = createTask('t-blocker', 'Closed Blocker', 'closed')
      const edge = createEdge('x-1', 't-blocker', 't-blocked', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(closedBlocker)

      const result = await engine.blockers('t-blocked')

      expect(result).toHaveLength(0)
    })

    it('should include inactive blockers when activeOnly=false', async () => {
      const closedBlocker = createTask('t-blocker', 'Closed Blocker', 'closed')
      const edge = createEdge('x-1', 't-blocker', 't-blocked', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(closedBlocker)

      const result = await engine.blockers('t-blocked', { activeOnly: false })

      expect(result).toHaveLength(1)
    })

    it('should get transitive blockers', async () => {
      const blockerA = createTask('t-a', 'Blocker A', 'open')
      const blockerB = createTask('t-b', 'Blocker B', 'open')

      vi.mocked(storage.getEdgesTo)
        .mockResolvedValueOnce([createEdge('x-1', 't-a', 't-target', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 't-b', 't-a', 'blocks')])
        .mockResolvedValueOnce([])

      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(blockerA)
        .mockResolvedValueOnce(blockerB)

      const result = await engine.blockers('t-target', { transitive: true })

      expect(result).toHaveLength(2)
    })

    it('should respect maxDepth', async () => {
      // maxDepth=0 allows depth 0 (direct blockers) but no recursion
      // maxDepth=1 would allow depth 0 and depth 1 (blockers of blockers)
      const directBlocker = createTask('t-direct', 'Direct Blocker', 'open')
      const transitiveBlocker = createTask('t-transitive', 'Transitive', 'open')

      vi.mocked(storage.getEdgesTo)
        .mockResolvedValueOnce([createEdge('x-1', 't-direct', 't-target', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 't-transitive', 't-direct', 'blocks')])

      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(directBlocker)
        .mockResolvedValueOnce(transitiveBlocker)

      // With maxDepth=0 and transitive=true, we get direct blocker but NOT its blockers
      const result = await engine.blockers('t-target', {
        transitive: true,
        maxDepth: 0,
      })

      // Should have 1 result (direct blocker), not 2 (would include transitive)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-direct')
    })
  })

  describe('blocking()', () => {
    it('should get nodes this blocks', async () => {
      const blocked = createTask('t-blocked', 'Blocked Task', 'open')
      const edge = createEdge('x-1', 't-blocker', 't-blocked', 'blocks')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(blocked)

      const result = await engine.blocking('t-blocker')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-blocked')
    })
  })

  describe('isBlocking()', () => {
    it('should return true for direct blocking', async () => {
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([
        createEdge('x-1', 't-a', 't-b', 'blocks'),
      ])

      const result = await engine.isBlocking('t-a', 't-b')

      expect(result).toBe(true)
    })

    it('should return true for transitive blocking', async () => {
      vi.mocked(storage.getEdgesFrom)
        .mockResolvedValueOnce([createEdge('x-1', 't-a', 't-b', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 't-b', 't-c', 'blocks')])

      const result = await engine.isBlocking('t-a', 't-c')

      expect(result).toBe(true)
    })

    it('should return false when not blocking', async () => {
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([])

      const result = await engine.isBlocking('t-a', 't-b')

      expect(result).toBe(false)
    })

    it('should handle cycles in graph without infinite loop', async () => {
      vi.mocked(storage.getEdgesFrom)
        .mockResolvedValueOnce([createEdge('x-1', 't-a', 't-b', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 't-b', 't-a', 'blocks')]) // cycle back
        .mockResolvedValue([])

      // Should terminate without infinite loop
      const result = await engine.isBlocking('t-a', 't-c')
      expect(result).toBe(false)
    })
  })

  describe('tasks()', () => {
    it('should get tasks that implement a context', async () => {
      const task = createTask('t-impl', 'Implementation')
      const edge = createEdge('x-1', 't-impl', 'c-context', 'implements')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(task)

      const result = await engine.tasks('c-context')

      expect(storage.getEdgesTo).toHaveBeenCalledWith('c-context', 'implements')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-impl')
    })

    it('should filter out non-tasks', async () => {
      const context = createContext('c-not-task', 'Not a task')
      const edge = createEdge('x-1', 'c-not-task', 'c-context', 'implements')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(context)

      const result = await engine.tasks('c-context')

      expect(result).toHaveLength(0)
    })
  })

  describe('context()', () => {
    it('should get context that a task implements', async () => {
      const context = createContext('c-context', 'Context')
      const edge = createEdge('x-1', 't-task', 'c-context', 'implements')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(context)

      const result = await engine.context('t-task')

      expect(storage.getEdgesFrom).toHaveBeenCalledWith('t-task', 'implements')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('c-context')
    })
  })

  describe('children()', () => {
    it('should get child nodes', async () => {
      const child = createContext('c-child', 'Child', { parent_id: 'c-parent' })
      vi.mocked(storage.queryNodes).mockResolvedValue([child])

      const result = await engine.children('c-parent')

      expect(storage.queryNodes).toHaveBeenCalledWith({ parent_id: 'c-parent' })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('c-child')
    })
  })

  describe('parent()', () => {
    it('should get parent node', async () => {
      const child = createContext('c-child', 'Child', { parent_id: 'c-parent' })
      const parent = createContext('c-parent', 'Parent')
      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(parent)

      const result = await engine.parent('c-child')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('c-parent')
    })

    it('should return null when no parent', async () => {
      const node = createContext('c-root', 'Root')
      vi.mocked(storage.getNode).mockResolvedValue(node)

      const result = await engine.parent('c-root')

      expect(result).toBeNull()
    })

    it('should return null when node not found', async () => {
      vi.mocked(storage.getNode).mockResolvedValue(null)

      const result = await engine.parent('c-missing')

      expect(result).toBeNull()
    })
  })

  describe('ancestors()', () => {
    it('should get all ancestors', async () => {
      const child = createContext('c-child', 'Child', { parent_id: 'c-mid' })
      const mid = createContext('c-mid', 'Mid', { parent_id: 'c-root' })
      const root = createContext('c-root', 'Root')

      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(mid)
        .mockResolvedValueOnce(mid) // gets mid again for parent_id check
        .mockResolvedValueOnce(root)
        .mockResolvedValueOnce(root) // gets root again for parent_id check

      const result = await engine.ancestors('c-child')

      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('should return empty for root node', async () => {
      const root = createContext('c-root', 'Root')
      vi.mocked(storage.getNode).mockResolvedValue(root)

      const result = await engine.ancestors('c-root')

      expect(result).toHaveLength(0)
    })
  })

  describe('descendants()', () => {
    it('should get all descendants', async () => {
      const child1 = createContext('c-c1', 'Child 1', { parent_id: 'c-root' })
      const child2 = createContext('c-c2', 'Child 2', { parent_id: 'c-root' })
      const grandchild = createContext('c-gc', 'Grandchild', { parent_id: 'c-c1' })

      vi.mocked(storage.queryNodes)
        .mockResolvedValueOnce([child1, child2]) // children of root
        .mockResolvedValueOnce([grandchild]) // children of c1
        .mockResolvedValueOnce([]) // children of c2
        .mockResolvedValueOnce([]) // children of gc

      const result = await engine.descendants('c-root')

      expect(result).toHaveLength(3)
    })
  })

  describe('ready()', () => {
    it('should return open tasks with no active blockers', async () => {
      const task = createTask('t-ready', 'Ready Task', 'open')
      vi.mocked(storage.queryNodes).mockResolvedValue([task])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([]) // no blockers

      const result = await engine.ready()

      expect(storage.queryNodes).toHaveBeenCalledWith({
        type: 'task',
        status: 'open',
        archived: false,
      })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-ready')
    })

    it('should exclude tasks with active blockers', async () => {
      const task = createTask('t-blocked', 'Blocked Task', 'open')
      const blocker = createTask('t-blocker', 'Blocker', 'open')
      vi.mocked(storage.queryNodes).mockResolvedValue([task])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([
        createEdge('x-1', 't-blocker', 't-blocked', 'blocks'),
      ])
      vi.mocked(storage.getNode).mockResolvedValue(blocker)

      const result = await engine.ready()

      expect(result).toHaveLength(0)
    })

    it('should include tasks whose blockers are closed', async () => {
      const task = createTask('t-ready', 'Ready Task', 'open')
      const closedBlocker = createTask('t-blocker', 'Closed', 'closed')
      vi.mocked(storage.queryNodes).mockResolvedValue([task])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([
        createEdge('x-1', 't-blocker', 't-ready', 'blocks'),
      ])
      vi.mocked(storage.getNode).mockResolvedValue(closedBlocker)

      const result = await engine.ready()

      expect(result).toHaveLength(1)
    })

    it('should include tasks whose blockers are archived', async () => {
      const task = createTask('t-ready', 'Ready Task', 'open')
      const archivedBlocker = createTask('t-blocker', 'Archived', 'open', {
        archived: true,
      })
      vi.mocked(storage.queryNodes).mockResolvedValue([task])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([
        createEdge('x-1', 't-blocker', 't-ready', 'blocks'),
      ])
      vi.mocked(storage.getNode).mockResolvedValue(archivedBlocker)

      const result = await engine.ready()

      expect(result).toHaveLength(1)
    })

    it('should filter by tags', async () => {
      const task1 = createTask('t-1', 'Task 1', 'open', { tags: ['urgent'] })
      const task2 = createTask('t-2', 'Task 2', 'open', { tags: ['low'] })
      vi.mocked(storage.queryNodes).mockResolvedValue([task1, task2])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ tags: ['urgent'] })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-1')
    })

    it('should filter by priority', async () => {
      const highPriority = createTask('t-high', 'High', 'open', { priority: 0 })
      const lowPriority = createTask('t-low', 'Low', 'open', { priority: 4 })
      vi.mocked(storage.queryNodes).mockResolvedValue([highPriority, lowPriority])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ priority: 0 })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-high')
    })

    it('should filter by priority range', async () => {
      const p0 = createTask('t-0', 'P0', 'open', { priority: 0 })
      const p2 = createTask('t-2', 'P2', 'open', { priority: 2 })
      const p4 = createTask('t-4', 'P4', 'open', { priority: 4 })
      vi.mocked(storage.queryNodes).mockResolvedValue([p0, p2, p4])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ priority: { min: 1, max: 3 } })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-2')
    })

    it('should filter by assignee', async () => {
      const assigned = createTask('t-assigned', 'Assigned', 'open', {
        assignee: 'alice',
      })
      const unassigned = createTask('t-unassigned', 'Unassigned', 'open')
      vi.mocked(storage.queryNodes).mockResolvedValue([assigned, unassigned])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ assignee: 'alice' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t-assigned')
    })

    it('should respect limit', async () => {
      const tasks = [
        createTask('t-1', 'Task 1', 'open'),
        createTask('t-2', 'Task 2', 'open'),
        createTask('t-3', 'Task 3', 'open'),
      ]
      vi.mocked(storage.queryNodes).mockResolvedValue(tasks)
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ limit: 2 })

      expect(result).toHaveLength(2)
    })
  })

  describe('feedback()', () => {
    it('should get feedback for a target', async () => {
      const fb = createFeedback('f-1', 'c-context')
      vi.mocked(storage.queryNodes).mockResolvedValue([fb])

      const result = await engine.feedback('c-context')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should filter by type', async () => {
      const comment = createFeedback('f-1', 'c-context', { feedback_type: 'comment' })
      const suggestion = createFeedback('f-2', 'c-context', {
        feedback_type: 'suggestion',
      })
      vi.mocked(storage.queryNodes).mockResolvedValue([comment, suggestion])

      const result = await engine.feedback('c-context', { type: 'comment' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should filter by resolved status', async () => {
      const resolved = createFeedback('f-1', 'c-context', { resolved: true })
      const unresolved = createFeedback('f-2', 'c-context', { resolved: false })
      vi.mocked(storage.queryNodes).mockResolvedValue([resolved, unresolved])

      const result = await engine.feedback('c-context', { resolved: true })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should exclude dismissed by default', async () => {
      const normal = createFeedback('f-1', 'c-context', { dismissed: false })
      const dismissed = createFeedback('f-2', 'c-context', { dismissed: true })
      vi.mocked(storage.queryNodes).mockResolvedValue([normal, dismissed])

      const result = await engine.feedback('c-context')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should include dismissed when requested', async () => {
      const normal = createFeedback('f-1', 'c-context', { dismissed: false })
      const dismissed = createFeedback('f-2', 'c-context', { dismissed: true })
      vi.mocked(storage.queryNodes).mockResolvedValue([normal, dismissed])

      const result = await engine.feedback('c-context', { includeDismissed: true })

      expect(result).toHaveLength(2)
    })
  })

  describe('unresolvedFeedback()', () => {
    it('should get unresolved feedback', async () => {
      const unresolved = createFeedback('f-1', 'c-context', { resolved: false })
      const resolved = createFeedback('f-2', 'c-context', { resolved: true })
      vi.mocked(storage.queryNodes).mockResolvedValue([unresolved, resolved])

      const result = await engine.unresolvedFeedback()

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should exclude dismissed feedback', async () => {
      const unresolved = createFeedback('f-1', 'c-context', {
        resolved: false,
        dismissed: false,
      })
      const dismissed = createFeedback('f-2', 'c-context', {
        resolved: false,
        dismissed: true,
      })
      vi.mocked(storage.queryNodes).mockResolvedValue([unresolved, dismissed])

      const result = await engine.unresolvedFeedback()

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should filter by target', async () => {
      const fb1 = createFeedback('f-1', 'c-context1', { resolved: false })
      const fb2 = createFeedback('f-2', 'c-context2', { resolved: false })
      vi.mocked(storage.queryNodes).mockResolvedValue([fb1, fb2])

      const result = await engine.unresolvedFeedback('c-context1')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })
  })

  // ============================================================================
  // Cross-Provider Resolution Tests
  // ============================================================================

  describe('Cross-Provider Resolution', () => {
    describe('with nodeResolver', () => {
      it('blockers() should call resolver for external URIs', async () => {
        const externalNode: StoredNode = {
          id: 'x-ext1',
          uuid: 'ext-uuid-1',
          type: 'external',
          title: 'External Blocker',
          status: 'open',
          uri: 'beads://./bd-blocker',
          source: 'beads',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        // Setup mock resolver
        const mockResolver = vi.fn().mockResolvedValue(externalNode)

        // Create engine with resolver
        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        // Setup storage mocks
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 't-local', 'blocks'),
        ])

        await engineWithResolver.blockers('t-local')

        // Resolver should be called for external URI
        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocker')
        // Note: External nodes don't appear in results because they don't
        // parse as valid Node types (context/task/feedback). The resolver is
        // still called to support ready() blocking checks.
      })

      it('blockers() should return local tasks resolved via resolver', async () => {
        // When resolver returns a valid task type, it should be in results
        const localBlocker = createTask('t-blocker', 'Local Blocker')
        const mockResolver = vi.fn().mockResolvedValue(localBlocker)

        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 't-local', 'blocks'),
        ])

        const result = await engineWithResolver.blockers('t-local')

        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocker')
        expect(result).toHaveLength(1)
        expect(result[0].title).toBe('Local Blocker')
      })

      it('blockers() should use storage for local IDs even with resolver', async () => {
        const localBlocker = createTask('t-blocker', 'Local Blocker')
        const mockResolver = vi.fn()

        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getNode).mockResolvedValue(localBlocker)
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 't-blocker', 't-local', 'blocks'),
        ])

        await engineWithResolver.blockers('t-local')

        // Resolver should NOT be called for local IDs
        expect(mockResolver).not.toHaveBeenCalled()
        expect(storage.getNode).toHaveBeenCalledWith('t-blocker')
      })

      it('blocking() should call resolver for external URIs', async () => {
        const externalNode: StoredNode = {
          id: 'x-ext1',
          uuid: 'ext-uuid-1',
          type: 'external',
          title: 'External Blocked',
          status: 'open',
          uri: 'beads://./bd-blocked',
          source: 'beads',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const mockResolver = vi.fn().mockResolvedValue(externalNode)
        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getEdgesFrom).mockResolvedValue([
          createEdge('e-1', 't-blocker', 'beads://./bd-blocked', 'blocks'),
        ])

        await engineWithResolver.blocking('t-blocker')

        // Resolver should be called for external URI
        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocked')
        // Note: External nodes don't appear in results because they don't
        // parse as valid Node types (context/task/feedback).
      })

      it('blocking() should return local tasks resolved via resolver', async () => {
        const localBlocked = createTask('t-blocked', 'Local Blocked Task')
        const mockResolver = vi.fn().mockResolvedValue(localBlocked)

        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getEdgesFrom).mockResolvedValue([
          createEdge('e-1', 't-blocker', 'beads://./bd-blocked', 'blocks'),
        ])

        const result = await engineWithResolver.blocking('t-blocker')

        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocked')
        expect(result).toHaveLength(1)
        expect(result[0].title).toBe('Local Blocked Task')
      })

      it('ready() should consider external blockers when resolver provided', async () => {
        const localTask = createTask('t-ready', 'Ready Task')
        const externalBlocker: StoredNode = {
          id: 'x-ext1',
          uuid: 'ext-uuid-1',
          type: 'external',
          title: 'External Blocker',
          status: 'open', // Active blocker
          uri: 'beads://./bd-blocker',
          source: 'beads',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const mockResolver = vi.fn().mockResolvedValue(externalBlocker)
        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.queryNodes).mockResolvedValue([localTask])
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 't-ready', 'blocks'),
        ])

        const result = await engineWithResolver.ready()

        // Task should NOT be ready because external blocker is active
        expect(result).toHaveLength(0)
      })

      it('ready() should include task when external blocker is closed', async () => {
        const localTask = createTask('t-ready', 'Ready Task')
        const closedBlocker: StoredNode = {
          id: 'x-ext1',
          uuid: 'ext-uuid-1',
          type: 'external',
          title: 'Closed External Blocker',
          status: 'closed', // Closed - not blocking
          uri: 'beads://./bd-blocker',
          source: 'beads',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const mockResolver = vi.fn().mockResolvedValue(closedBlocker)
        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.queryNodes).mockResolvedValue([localTask])
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 't-ready', 'blocks'),
        ])

        const result = await engineWithResolver.ready()

        // Task should be ready because external blocker is closed
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t-ready')
      })

      it('resolver returning null should skip the node', async () => {
        const mockResolver = vi.fn().mockResolvedValue(null)
        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-missing', 't-local', 'blocks'),
        ])

        const result = await engineWithResolver.blockers('t-local')

        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-missing')
        expect(result).toHaveLength(0)
      })
    })

    describe('without nodeResolver (backward compatibility)', () => {
      it('blockers() should skip external URIs that storage cannot find', async () => {
        vi.mocked(storage.getNode).mockResolvedValue(null)
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 't-local', 'blocks'),
        ])

        const result = await engine.blockers('t-local')

        expect(result).toHaveLength(0)
      })

      it('ready() should not be blocked by unresolvable external nodes', async () => {
        const localTask = createTask('t-ready', 'Ready Task')

        vi.mocked(storage.queryNodes).mockResolvedValue([localTask])
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-unresolvable', 't-ready', 'blocks'),
        ])
        vi.mocked(storage.getNode).mockResolvedValue(null)

        const result = await engine.ready()

        // Task should be ready because blocker cannot be resolved
        expect(result).toHaveLength(1)
      })
    })
  })
})
