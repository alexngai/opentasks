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

function createSpec(id: string, title: string, overrides: Partial<StoredNode> = {}): StoredNode {
  return {
    id,
    uuid: `uuid-${id}`,
    type: 'spec',
    title,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    archived: false,
    ...overrides,
  }
}

function createIssue(
  id: string,
  title: string,
  status: string = 'open',
  overrides: Partial<StoredNode> = {}
): StoredNode {
  return {
    id,
    uuid: `uuid-${id}`,
    type: 'issue',
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
      const spec = createSpec('s-abc1', 'Test Spec')
      vi.mocked(storage.queryNodes).mockResolvedValue([spec])

      const result = await engine.nodes({ type: 'spec' })

      expect(storage.queryNodes).toHaveBeenCalledWith({
        type: 'spec',
        status: undefined,
        tags: undefined,
        parent_id: undefined,
        archived: undefined,
        search: undefined,
        limit: undefined,
        offset: undefined,
      })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('s-abc1')
    })

    it('should filter out invalid nodes', async () => {
      const validSpec = createSpec('s-abc1', 'Test Spec')
      const invalidNode = { id: 'invalid', type: 'unknown' } as StoredNode
      vi.mocked(storage.queryNodes).mockResolvedValue([validSpec, invalidNode])

      const result = await engine.nodes({})

      // Only valid spec should be returned
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('s-abc1')
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
      const edge = createEdge('x-abc1', 's-a', 's-b', 'references')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])

      const result = await engine.edges({ from_id: 's-a' })

      expect(storage.getEdgesFrom).toHaveBeenCalledWith('s-a', undefined)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('x-abc1')
    })

    it('should query edges to a node', async () => {
      const edge = createEdge('x-abc1', 's-a', 's-b', 'references')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])

      const result = await engine.edges({ to_id: 's-b' })

      expect(storage.getEdgesTo).toHaveBeenCalledWith('s-b', undefined)
      expect(result).toHaveLength(1)
    })

    it('should return empty when no filter specified', async () => {
      const result = await engine.edges({})
      expect(result).toHaveLength(0)
    })

    it('should apply pagination', async () => {
      const edges = [
        createEdge('x-1', 's-a', 's-b', 'references'),
        createEdge('x-2', 's-a', 's-c', 'references'),
        createEdge('x-3', 's-a', 's-d', 'references'),
      ]
      vi.mocked(storage.getEdgesFrom).mockResolvedValue(edges)

      const result = await engine.edges({ from_id: 's-a', offset: 1, limit: 1 })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('x-2')
    })
  })

  describe('edgesFrom()', () => {
    it('should get edges from a node', async () => {
      const edge = createEdge('x-abc1', 's-a', 's-b', 'blocks')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])

      const result = await engine.edgesFrom('s-a', 'blocks')

      expect(storage.getEdgesFrom).toHaveBeenCalledWith('s-a', 'blocks')
      expect(result).toHaveLength(1)
    })
  })

  describe('edgesTo()', () => {
    it('should get edges to a node', async () => {
      const edge = createEdge('x-abc1', 's-a', 's-b', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])

      const result = await engine.edgesTo('s-b', 'blocks')

      expect(storage.getEdgesTo).toHaveBeenCalledWith('s-b', 'blocks')
      expect(result).toHaveLength(1)
    })
  })

  describe('edgesFor()', () => {
    it('should get all edges for a node (both directions)', async () => {
      const fromEdge = createEdge('x-1', 's-a', 's-b', 'blocks')
      const toEdge = createEdge('x-2', 's-c', 's-a', 'references')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([fromEdge])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([toEdge])

      const result = await engine.edgesFor('s-a')

      expect(result).toHaveLength(2)
      expect(result.map((e) => e.id).sort()).toEqual(['x-1', 'x-2'])
    })

    it('should deduplicate edges', async () => {
      const edge = createEdge('x-1', 's-a', 's-a', 'references') // self-reference
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])

      const result = await engine.edgesFor('s-a')

      expect(result).toHaveLength(1)
    })
  })

  describe('blockers()', () => {
    it('should get direct blockers', async () => {
      const blocker = createIssue('i-blocker', 'Blocking Issue', 'open')
      const edge = createEdge('x-1', 'i-blocker', 'i-blocked', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(blocker)

      const result = await engine.blockers('i-blocked')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-blocker')
    })

    it('should filter out inactive blockers by default', async () => {
      const closedBlocker = createIssue('i-blocker', 'Closed Blocker', 'closed')
      const edge = createEdge('x-1', 'i-blocker', 'i-blocked', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(closedBlocker)

      const result = await engine.blockers('i-blocked')

      expect(result).toHaveLength(0)
    })

    it('should include inactive blockers when activeOnly=false', async () => {
      const closedBlocker = createIssue('i-blocker', 'Closed Blocker', 'closed')
      const edge = createEdge('x-1', 'i-blocker', 'i-blocked', 'blocks')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(closedBlocker)

      const result = await engine.blockers('i-blocked', { activeOnly: false })

      expect(result).toHaveLength(1)
    })

    it('should get transitive blockers', async () => {
      const blockerA = createIssue('i-a', 'Blocker A', 'open')
      const blockerB = createIssue('i-b', 'Blocker B', 'open')

      vi.mocked(storage.getEdgesTo)
        .mockResolvedValueOnce([createEdge('x-1', 'i-a', 'i-target', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 'i-b', 'i-a', 'blocks')])
        .mockResolvedValueOnce([])

      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(blockerA)
        .mockResolvedValueOnce(blockerB)

      const result = await engine.blockers('i-target', { transitive: true })

      expect(result).toHaveLength(2)
    })

    it('should respect maxDepth', async () => {
      // maxDepth=0 allows depth 0 (direct blockers) but no recursion
      // maxDepth=1 would allow depth 0 and depth 1 (blockers of blockers)
      const directBlocker = createIssue('i-direct', 'Direct Blocker', 'open')
      const transitiveBlocker = createIssue('i-transitive', 'Transitive', 'open')

      vi.mocked(storage.getEdgesTo)
        .mockResolvedValueOnce([createEdge('x-1', 'i-direct', 'i-target', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 'i-transitive', 'i-direct', 'blocks')])

      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(directBlocker)
        .mockResolvedValueOnce(transitiveBlocker)

      // With maxDepth=0 and transitive=true, we get direct blocker but NOT its blockers
      const result = await engine.blockers('i-target', {
        transitive: true,
        maxDepth: 0,
      })

      // Should have 1 result (direct blocker), not 2 (would include transitive)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-direct')
    })
  })

  describe('blocking()', () => {
    it('should get nodes this blocks', async () => {
      const blocked = createIssue('i-blocked', 'Blocked Issue', 'open')
      const edge = createEdge('x-1', 'i-blocker', 'i-blocked', 'blocks')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(blocked)

      const result = await engine.blocking('i-blocker')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-blocked')
    })
  })

  describe('isBlocking()', () => {
    it('should return true for direct blocking', async () => {
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([
        createEdge('x-1', 'i-a', 'i-b', 'blocks'),
      ])

      const result = await engine.isBlocking('i-a', 'i-b')

      expect(result).toBe(true)
    })

    it('should return true for transitive blocking', async () => {
      vi.mocked(storage.getEdgesFrom)
        .mockResolvedValueOnce([createEdge('x-1', 'i-a', 'i-b', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 'i-b', 'i-c', 'blocks')])

      const result = await engine.isBlocking('i-a', 'i-c')

      expect(result).toBe(true)
    })

    it('should return false when not blocking', async () => {
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([])

      const result = await engine.isBlocking('i-a', 'i-b')

      expect(result).toBe(false)
    })

    it('should handle cycles in graph without infinite loop', async () => {
      vi.mocked(storage.getEdgesFrom)
        .mockResolvedValueOnce([createEdge('x-1', 'i-a', 'i-b', 'blocks')])
        .mockResolvedValueOnce([createEdge('x-2', 'i-b', 'i-a', 'blocks')]) // cycle back
        .mockResolvedValue([])

      // Should terminate without infinite loop
      const result = await engine.isBlocking('i-a', 'i-c')
      expect(result).toBe(false)
    })
  })

  describe('implementers()', () => {
    it('should get issues that implement a spec', async () => {
      const issue = createIssue('i-impl', 'Implementation')
      const edge = createEdge('x-1', 'i-impl', 's-spec', 'implements')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(issue)

      const result = await engine.implementers('s-spec')

      expect(storage.getEdgesTo).toHaveBeenCalledWith('s-spec', 'implements')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-impl')
    })

    it('should filter out non-issues', async () => {
      const spec = createSpec('s-not-issue', 'Not an issue')
      const edge = createEdge('x-1', 's-not-issue', 's-spec', 'implements')
      vi.mocked(storage.getEdgesTo).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(spec)

      const result = await engine.implementers('s-spec')

      expect(result).toHaveLength(0)
    })
  })

  describe('specs()', () => {
    it('should get specs that an issue implements', async () => {
      const spec = createSpec('s-spec', 'Spec')
      const edge = createEdge('x-1', 'i-issue', 's-spec', 'implements')
      vi.mocked(storage.getEdgesFrom).mockResolvedValue([edge])
      vi.mocked(storage.getNode).mockResolvedValue(spec)

      const result = await engine.specs('i-issue')

      expect(storage.getEdgesFrom).toHaveBeenCalledWith('i-issue', 'implements')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('s-spec')
    })
  })

  describe('children()', () => {
    it('should get child nodes', async () => {
      const child = createSpec('s-child', 'Child', { parent_id: 's-parent' })
      vi.mocked(storage.queryNodes).mockResolvedValue([child])

      const result = await engine.children('s-parent')

      expect(storage.queryNodes).toHaveBeenCalledWith({ parent_id: 's-parent' })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('s-child')
    })
  })

  describe('parent()', () => {
    it('should get parent node', async () => {
      const child = createSpec('s-child', 'Child', { parent_id: 's-parent' })
      const parent = createSpec('s-parent', 'Parent')
      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(parent)

      const result = await engine.parent('s-child')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('s-parent')
    })

    it('should return null when no parent', async () => {
      const node = createSpec('s-root', 'Root')
      vi.mocked(storage.getNode).mockResolvedValue(node)

      const result = await engine.parent('s-root')

      expect(result).toBeNull()
    })

    it('should return null when node not found', async () => {
      vi.mocked(storage.getNode).mockResolvedValue(null)

      const result = await engine.parent('s-missing')

      expect(result).toBeNull()
    })
  })

  describe('ancestors()', () => {
    it('should get all ancestors', async () => {
      const child = createSpec('s-child', 'Child', { parent_id: 's-mid' })
      const mid = createSpec('s-mid', 'Mid', { parent_id: 's-root' })
      const root = createSpec('s-root', 'Root')

      vi.mocked(storage.getNode)
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(mid)
        .mockResolvedValueOnce(mid) // gets mid again for parent_id check
        .mockResolvedValueOnce(root)
        .mockResolvedValueOnce(root) // gets root again for parent_id check

      const result = await engine.ancestors('s-child')

      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('should return empty for root node', async () => {
      const root = createSpec('s-root', 'Root')
      vi.mocked(storage.getNode).mockResolvedValue(root)

      const result = await engine.ancestors('s-root')

      expect(result).toHaveLength(0)
    })
  })

  describe('descendants()', () => {
    it('should get all descendants', async () => {
      const child1 = createSpec('s-c1', 'Child 1', { parent_id: 's-root' })
      const child2 = createSpec('s-c2', 'Child 2', { parent_id: 's-root' })
      const grandchild = createSpec('s-gc', 'Grandchild', { parent_id: 's-c1' })

      vi.mocked(storage.queryNodes)
        .mockResolvedValueOnce([child1, child2]) // children of root
        .mockResolvedValueOnce([grandchild]) // children of c1
        .mockResolvedValueOnce([]) // children of c2
        .mockResolvedValueOnce([]) // children of gc

      const result = await engine.descendants('s-root')

      expect(result).toHaveLength(3)
    })
  })

  describe('ready()', () => {
    it('should return open issues with no active blockers', async () => {
      const issue = createIssue('i-ready', 'Ready Issue', 'open')
      vi.mocked(storage.queryNodes).mockResolvedValue([issue])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([]) // no blockers

      const result = await engine.ready()

      expect(storage.queryNodes).toHaveBeenCalledWith({
        type: 'issue',
        status: 'open',
        archived: false,
      })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-ready')
    })

    it('should exclude issues with active blockers', async () => {
      const issue = createIssue('i-blocked', 'Blocked Issue', 'open')
      const blocker = createIssue('i-blocker', 'Blocker', 'open')
      vi.mocked(storage.queryNodes).mockResolvedValue([issue])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([
        createEdge('x-1', 'i-blocker', 'i-blocked', 'blocks'),
      ])
      vi.mocked(storage.getNode).mockResolvedValue(blocker)

      const result = await engine.ready()

      expect(result).toHaveLength(0)
    })

    it('should include issues whose blockers are closed', async () => {
      const issue = createIssue('i-ready', 'Ready Issue', 'open')
      const closedBlocker = createIssue('i-blocker', 'Closed', 'closed')
      vi.mocked(storage.queryNodes).mockResolvedValue([issue])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([
        createEdge('x-1', 'i-blocker', 'i-ready', 'blocks'),
      ])
      vi.mocked(storage.getNode).mockResolvedValue(closedBlocker)

      const result = await engine.ready()

      expect(result).toHaveLength(1)
    })

    it('should include issues whose blockers are archived', async () => {
      const issue = createIssue('i-ready', 'Ready Issue', 'open')
      const archivedBlocker = createIssue('i-blocker', 'Archived', 'open', {
        archived: true,
      })
      vi.mocked(storage.queryNodes).mockResolvedValue([issue])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([
        createEdge('x-1', 'i-blocker', 'i-ready', 'blocks'),
      ])
      vi.mocked(storage.getNode).mockResolvedValue(archivedBlocker)

      const result = await engine.ready()

      expect(result).toHaveLength(1)
    })

    it('should filter by tags', async () => {
      const issue1 = createIssue('i-1', 'Issue 1', 'open', { tags: ['urgent'] })
      const issue2 = createIssue('i-2', 'Issue 2', 'open', { tags: ['low'] })
      vi.mocked(storage.queryNodes).mockResolvedValue([issue1, issue2])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ tags: ['urgent'] })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-1')
    })

    it('should filter by priority', async () => {
      const highPriority = createIssue('i-high', 'High', 'open', { priority: 0 })
      const lowPriority = createIssue('i-low', 'Low', 'open', { priority: 4 })
      vi.mocked(storage.queryNodes).mockResolvedValue([highPriority, lowPriority])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ priority: 0 })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-high')
    })

    it('should filter by priority range', async () => {
      const p0 = createIssue('i-0', 'P0', 'open', { priority: 0 })
      const p2 = createIssue('i-2', 'P2', 'open', { priority: 2 })
      const p4 = createIssue('i-4', 'P4', 'open', { priority: 4 })
      vi.mocked(storage.queryNodes).mockResolvedValue([p0, p2, p4])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ priority: { min: 1, max: 3 } })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-2')
    })

    it('should filter by assignee', async () => {
      const assigned = createIssue('i-assigned', 'Assigned', 'open', {
        assignee: 'alice',
      })
      const unassigned = createIssue('i-unassigned', 'Unassigned', 'open')
      vi.mocked(storage.queryNodes).mockResolvedValue([assigned, unassigned])
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ assignee: 'alice' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('i-assigned')
    })

    it('should respect limit', async () => {
      const issues = [
        createIssue('i-1', 'Issue 1', 'open'),
        createIssue('i-2', 'Issue 2', 'open'),
        createIssue('i-3', 'Issue 3', 'open'),
      ]
      vi.mocked(storage.queryNodes).mockResolvedValue(issues)
      vi.mocked(storage.getEdgesTo).mockResolvedValue([])

      const result = await engine.ready({ limit: 2 })

      expect(result).toHaveLength(2)
    })
  })

  describe('feedback()', () => {
    it('should get feedback for a target', async () => {
      const fb = createFeedback('f-1', 's-spec')
      vi.mocked(storage.queryNodes).mockResolvedValue([fb])

      const result = await engine.feedback('s-spec')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should filter by type', async () => {
      const comment = createFeedback('f-1', 's-spec', { feedback_type: 'comment' })
      const suggestion = createFeedback('f-2', 's-spec', {
        feedback_type: 'suggestion',
      })
      vi.mocked(storage.queryNodes).mockResolvedValue([comment, suggestion])

      const result = await engine.feedback('s-spec', { type: 'comment' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should filter by resolved status', async () => {
      const resolved = createFeedback('f-1', 's-spec', { resolved: true })
      const unresolved = createFeedback('f-2', 's-spec', { resolved: false })
      vi.mocked(storage.queryNodes).mockResolvedValue([resolved, unresolved])

      const result = await engine.feedback('s-spec', { resolved: true })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should exclude dismissed by default', async () => {
      const normal = createFeedback('f-1', 's-spec', { dismissed: false })
      const dismissed = createFeedback('f-2', 's-spec', { dismissed: true })
      vi.mocked(storage.queryNodes).mockResolvedValue([normal, dismissed])

      const result = await engine.feedback('s-spec')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should include dismissed when requested', async () => {
      const normal = createFeedback('f-1', 's-spec', { dismissed: false })
      const dismissed = createFeedback('f-2', 's-spec', { dismissed: true })
      vi.mocked(storage.queryNodes).mockResolvedValue([normal, dismissed])

      const result = await engine.feedback('s-spec', { includeDismissed: true })

      expect(result).toHaveLength(2)
    })
  })

  describe('unresolvedFeedback()', () => {
    it('should get unresolved feedback', async () => {
      const unresolved = createFeedback('f-1', 's-spec', { resolved: false })
      const resolved = createFeedback('f-2', 's-spec', { resolved: true })
      vi.mocked(storage.queryNodes).mockResolvedValue([unresolved, resolved])

      const result = await engine.unresolvedFeedback()

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should exclude dismissed feedback', async () => {
      const unresolved = createFeedback('f-1', 's-spec', {
        resolved: false,
        dismissed: false,
      })
      const dismissed = createFeedback('f-2', 's-spec', {
        resolved: false,
        dismissed: true,
      })
      vi.mocked(storage.queryNodes).mockResolvedValue([unresolved, dismissed])

      const result = await engine.unresolvedFeedback()

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('f-1')
    })

    it('should filter by target', async () => {
      const fb1 = createFeedback('f-1', 's-spec1', { resolved: false })
      const fb2 = createFeedback('f-2', 's-spec2', { resolved: false })
      vi.mocked(storage.queryNodes).mockResolvedValue([fb1, fb2])

      const result = await engine.unresolvedFeedback('s-spec1')

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
          createEdge('e-1', 'beads://./bd-blocker', 'i-local', 'blocks'),
        ])

        await engineWithResolver.blockers('i-local')

        // Resolver should be called for external URI
        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocker')
        // Note: External nodes don't appear in results because they don't
        // parse as valid Node types (spec/issue/feedback). The resolver is
        // still called to support ready() blocking checks.
      })

      it('blockers() should return local issues resolved via resolver', async () => {
        // When resolver returns a valid issue type, it should be in results
        const localBlocker = createIssue('i-blocker', 'Local Blocker')
        const mockResolver = vi.fn().mockResolvedValue(localBlocker)

        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 'i-local', 'blocks'),
        ])

        const result = await engineWithResolver.blockers('i-local')

        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocker')
        expect(result).toHaveLength(1)
        expect(result[0].title).toBe('Local Blocker')
      })

      it('blockers() should use storage for local IDs even with resolver', async () => {
        const localBlocker = createIssue('i-blocker', 'Local Blocker')
        const mockResolver = vi.fn()

        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getNode).mockResolvedValue(localBlocker)
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'i-blocker', 'i-local', 'blocks'),
        ])

        await engineWithResolver.blockers('i-local')

        // Resolver should NOT be called for local IDs
        expect(mockResolver).not.toHaveBeenCalled()
        expect(storage.getNode).toHaveBeenCalledWith('i-blocker')
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
          createEdge('e-1', 'i-blocker', 'beads://./bd-blocked', 'blocks'),
        ])

        await engineWithResolver.blocking('i-blocker')

        // Resolver should be called for external URI
        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocked')
        // Note: External nodes don't appear in results because they don't
        // parse as valid Node types (spec/issue/feedback).
      })

      it('blocking() should return local issues resolved via resolver', async () => {
        const localBlocked = createIssue('i-blocked', 'Local Blocked Issue')
        const mockResolver = vi.fn().mockResolvedValue(localBlocked)

        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getEdgesFrom).mockResolvedValue([
          createEdge('e-1', 'i-blocker', 'beads://./bd-blocked', 'blocks'),
        ])

        const result = await engineWithResolver.blocking('i-blocker')

        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-blocked')
        expect(result).toHaveLength(1)
        expect(result[0].title).toBe('Local Blocked Issue')
      })

      it('ready() should consider external blockers when resolver provided', async () => {
        const localIssue = createIssue('i-ready', 'Ready Issue')
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

        vi.mocked(storage.queryNodes).mockResolvedValue([localIssue])
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 'i-ready', 'blocks'),
        ])

        const result = await engineWithResolver.ready()

        // Issue should NOT be ready because external blocker is active
        expect(result).toHaveLength(0)
      })

      it('ready() should include issue when external blocker is closed', async () => {
        const localIssue = createIssue('i-ready', 'Ready Issue')
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

        vi.mocked(storage.queryNodes).mockResolvedValue([localIssue])
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 'i-ready', 'blocks'),
        ])

        const result = await engineWithResolver.ready()

        // Issue should be ready because external blocker is closed
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('i-ready')
      })

      it('resolver returning null should skip the node', async () => {
        const mockResolver = vi.fn().mockResolvedValue(null)
        const engineWithResolver = createQueryEngine({
          storage,
          nodeResolver: mockResolver,
        })

        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-missing', 'i-local', 'blocks'),
        ])

        const result = await engineWithResolver.blockers('i-local')

        expect(mockResolver).toHaveBeenCalledWith('beads://./bd-missing')
        expect(result).toHaveLength(0)
      })
    })

    describe('without nodeResolver (backward compatibility)', () => {
      it('blockers() should skip external URIs that storage cannot find', async () => {
        vi.mocked(storage.getNode).mockResolvedValue(null)
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-blocker', 'i-local', 'blocks'),
        ])

        const result = await engine.blockers('i-local')

        expect(result).toHaveLength(0)
      })

      it('ready() should not be blocked by unresolvable external nodes', async () => {
        const localIssue = createIssue('i-ready', 'Ready Issue')

        vi.mocked(storage.queryNodes).mockResolvedValue([localIssue])
        vi.mocked(storage.getEdgesTo).mockResolvedValue([
          createEdge('e-1', 'beads://./bd-unresolvable', 'i-ready', 'blocks'),
        ])
        vi.mocked(storage.getNode).mockResolvedValue(null)

        const result = await engine.ready()

        // Issue should be ready because blocker cannot be resolved
        expect(result).toHaveLength(1)
      })
    })
  })
})
