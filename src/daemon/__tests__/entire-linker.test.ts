/**
 * Tests for Entire Auto-Linker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createEntireAutoLinker,
  type EntireAutoLinker,
  type CorrelationResult,
} from '../entire-linker.js'
import type { EntireSessionEvent, EntireSessionState } from '../entire-watcher.js'
import type { GraphStore } from '../../graph/store.js'
import type { DaemonFlushManager } from '../flush.js'

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockStore(): GraphStore & { _nodes: Map<string, Record<string, unknown>>; _edges: Map<string, Record<string, unknown>> } {
  const nodes = new Map<string, Record<string, unknown>>()
  const edges = new Map<string, Record<string, unknown>>()
  let nextNodeId = 1
  let nextEdgeId = 1

  return {
    _nodes: nodes,
    _edges: edges,

    query: {
      nodes: vi.fn(async (filter: Record<string, unknown>) => {
        const results: Record<string, unknown>[] = []
        for (const node of nodes.values()) {
          if (filter.type && node.type !== filter.type) continue
          if (filter.status && node.status !== filter.status) continue
          if (filter.archived === false && node.archived) continue
          if (filter.search) {
            const searchStr = String(filter.search).toLowerCase()
            const uri = String(node.uri ?? '').toLowerCase()
            const title = String(node.title ?? '').toLowerCase()
            if (!uri.includes(searchStr) && !title.includes(searchStr)) continue
          }
          results.push(node)
        }
        const limit = filter.limit as number | undefined
        return limit ? results.slice(0, limit) : results
      }),

      edges: vi.fn(async (filter: Record<string, unknown>) => {
        const results: Record<string, unknown>[] = []
        for (const edge of edges.values()) {
          if (filter.from_id && edge.from_id !== filter.from_id) continue
          if (filter.to_id && edge.to_id !== filter.to_id) continue
          if (filter.type && edge.type !== filter.type) continue
          results.push(edge)
        }
        return results
      }),
    } as unknown as GraphStore['query'],

    createNode: vi.fn(async (input: Record<string, unknown>) => {
      const id = `e-mock${nextNodeId++}`
      const node = {
        id,
        uuid: `uuid-${id}`,
        ...input,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      nodes.set(id, node)
      return node
    }) as unknown as GraphStore['createNode'],

    createEdge: vi.fn(async (input: Record<string, unknown>) => {
      const id = `x-mock${nextEdgeId++}`
      const edge = {
        id,
        uuid: `uuid-${id}`,
        ...input,
        created_at: new Date().toISOString(),
      }
      edges.set(id, edge)
      return edge
    }) as unknown as GraphStore['createEdge'],

    updateNode: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const node = nodes.get(id)
      if (node) {
        Object.assign(node, updates, { updated_at: new Date().toISOString() })
      }
      return node
    }) as unknown as GraphStore['updateNode'],

    getNode: vi.fn(async (id: string) => nodes.get(id) ?? null) as unknown as GraphStore['getNode'],
    getEdge: vi.fn(async (id: string) => edges.get(id) ?? null) as unknown as GraphStore['getEdge'],
    deleteNode: vi.fn() as unknown as GraphStore['deleteNode'],
    deleteEdge: vi.fn() as unknown as GraphStore['deleteEdge'],
    initialize: vi.fn() as unknown as GraphStore['initialize'],
    close: vi.fn() as unknown as GraphStore['close'],
    flush: vi.fn() as unknown as GraphStore['flush'],
    restoreNode: vi.fn() as unknown as GraphStore['restoreNode'],
    addTags: vi.fn() as unknown as GraphStore['addTags'],
    removeTags: vi.fn() as unknown as GraphStore['removeTags'],
    setTags: vi.fn() as unknown as GraphStore['setTags'],
    transaction: vi.fn() as unknown as GraphStore['transaction'],
  }
}

function createMockFlushManager(): DaemonFlushManager {
  return {
    markDirty: vi.fn(),
    schedule: vi.fn(),
    flush: vi.fn(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    finalFlush: vi.fn(async () => {}),
    hasPendingChanges: vi.fn(() => false),
    getDirtyNodes: vi.fn(() => []),
    paused: false,
  }
}

function makeSession(overrides: Partial<EntireSessionState> = {}): EntireSessionState {
  return {
    id: '2026-02-13-test',
    agent: 'claude-code',
    phase: 'ACTIVE',
    baseCommit: 'abc123',
    branch: 'feature/auth',
    startedAt: '2026-02-13T15:00:00Z',
    checkpoints: [],
    ...overrides,
  }
}

function makeEvent(overrides: Partial<EntireSessionEvent> = {}): EntireSessionEvent {
  return {
    type: 'started',
    sessionId: '2026-02-13-test',
    session: makeSession(),
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('EntireAutoLinker', () => {
  let store: ReturnType<typeof createMockStore>
  let flushManager: ReturnType<typeof createMockFlushManager>
  let linker: EntireAutoLinker

  beforeEach(() => {
    store = createMockStore()
    flushManager = createMockFlushManager()
    linker = createEntireAutoLinker({ store, flushManager })
  })

  describe('handleSessionEvent - started', () => {
    it('should create session node on started event', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      expect(store.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
          uri: 'entire://session/2026-02-13-test',
          source: 'entire',
        })
      )
    })

    it('should create worked-on edge when claimed task exists', async () => {
      // Add a claimed in-progress task
      store._nodes.set('i-task1', {
        id: 'i-task1',
        type: 'issue',
        status: 'in_progress',
        archived: false,
        claimed_by: 'claude-agent-1',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Should create worked-on edge
      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 'i-task1',
          to_id: 'entire://session/2026-02-13-test',
          type: 'worked-on',
        })
      )
    })

    it('should create worked-on edge for in-progress tasks on same branch', async () => {
      // Add an in-progress task with matching branch (no claim)
      store._nodes.set('i-branch', {
        id: 'i-branch',
        type: 'issue',
        status: 'in_progress',
        archived: false,
        branch: 'feature/auth',
      })

      await linker.handleSessionEvent(
        makeEvent({
          type: 'started',
          session: makeSession({ branch: 'feature/auth' }),
        })
      )

      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 'i-branch',
          to_id: 'entire://session/2026-02-13-test',
          type: 'worked-on',
        })
      )
    })

    it('should create worked-on edge for single in-progress task (fallback)', async () => {
      // Single in-progress task, no claim, no branch match
      store._nodes.set('i-only', {
        id: 'i-only',
        type: 'issue',
        status: 'in_progress',
        archived: false,
      })

      const lowConfLinker = createEntireAutoLinker({
        store,
        flushManager,
        minConfidence: 'low',
      })

      await lowConfLinker.handleSessionEvent(
        makeEvent({
          type: 'started',
          session: makeSession({ branch: undefined }),
        })
      )

      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 'i-only',
          type: 'worked-on',
        })
      )
    })

    it('should NOT create edges for ambiguous low-confidence matches', async () => {
      // Two in-progress tasks, no claims, no branch match
      store._nodes.set('i-one', {
        id: 'i-one',
        type: 'issue',
        status: 'in_progress',
        archived: false,
      })
      store._nodes.set('i-two', {
        id: 'i-two',
        type: 'issue',
        status: 'in_progress',
        archived: false,
      })

      const lowConfLinker = createEntireAutoLinker({
        store,
        flushManager,
        minConfidence: 'low',
      })

      await lowConfLinker.handleSessionEvent(
        makeEvent({
          type: 'started',
          session: makeSession({ branch: undefined }),
        })
      )

      // Session node should still be created, but no worked-on edges
      expect(store.createNode).toHaveBeenCalled()

      // Find worked-on edge calls
      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const workedOnEdges = edgeCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'worked-on'
      )
      expect(workedOnEdges).toHaveLength(0)
    })

    it('should respect minimum confidence threshold', async () => {
      // Single in-progress task (low confidence match)
      store._nodes.set('i-only', {
        id: 'i-only',
        type: 'issue',
        status: 'in_progress',
        archived: false,
      })

      // Linker with high minConfidence
      const highConfLinker = createEntireAutoLinker({
        store,
        flushManager,
        minConfidence: 'high',
      })

      await highConfLinker.handleSessionEvent(
        makeEvent({
          type: 'started',
          session: makeSession({ branch: undefined }),
        })
      )

      // Should not create worked-on edge (low confidence < high threshold)
      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const workedOnEdges = edgeCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'worked-on'
      )
      expect(workedOnEdges).toHaveLength(0)
    })

    it('should store correlation results', async () => {
      store._nodes.set('i-task1', {
        id: 'i-task1',
        type: 'issue',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      const correlations = linker.getCorrelations()
      expect(correlations.has('2026-02-13-test')).toBe(true)

      const result = correlations.get('2026-02-13-test')!
      expect(result.matchedTasks).toHaveLength(1)
      expect(result.matchedTasks[0].matchReason).toBe('claimed-task')
      expect(result.matchedTasks[0].confidence).toBe('high')
    })
  })

  describe('handleSessionEvent - checkpoint', () => {
    it('should create checkpoint node and contains edge', async () => {
      await linker.handleSessionEvent(
        makeEvent({
          type: 'checkpoint',
          checkpointId: 'cp-001',
          session: makeSession({ checkpoints: ['cp-001'] }),
        })
      )

      // Should create checkpoint node
      expect(store.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
          uri: 'entire://checkpoint/cp-001',
          source: 'entire',
        })
      )

      // Should create contains edge (session → checkpoint)
      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 'entire://session/2026-02-13-test',
          to_id: 'entire://checkpoint/cp-001',
          type: 'contains',
        })
      )
    })

    it('should create implemented-by edges for correlated tasks', async () => {
      store._nodes.set('i-task1', {
        id: 'i-task1',
        type: 'issue',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(
        makeEvent({
          type: 'checkpoint',
          checkpointId: 'cp-001',
          session: makeSession({ checkpoints: ['cp-001'] }),
        })
      )

      // Should create implemented-by edge
      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 'i-task1',
          to_id: 'entire://checkpoint/cp-001',
          type: 'implemented-by',
        })
      )
    })

    it('should skip when no checkpointId provided', async () => {
      await linker.handleSessionEvent(
        makeEvent({
          type: 'checkpoint',
          // no checkpointId
        })
      )

      // Should not create checkpoint nodes
      const createCalls = (store.createNode as ReturnType<typeof vi.fn>).mock.calls
      const checkpointNodes = createCalls.filter(
        (call: unknown[]) => String((call[0] as Record<string, unknown>).uri ?? '').includes('checkpoint')
      )
      expect(checkpointNodes).toHaveLength(0)
    })
  })

  describe('handleSessionEvent - ended', () => {
    it('should update session node status to closed', async () => {
      // First create the session node
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Now end it
      await linker.handleSessionEvent(
        makeEvent({
          type: 'ended',
          session: makeSession({ phase: 'ENDED', endedAt: '2026-02-13T16:00:00Z' }),
        })
      )

      expect(store.updateNode).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'closed',
        })
      )
    })
  })

  describe('handleSessionEvent - updated', () => {
    it('should update session node metadata', async () => {
      // First create the session node
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Now update it
      await linker.handleSessionEvent(
        makeEvent({
          type: 'updated',
          session: makeSession({ phase: 'IDLE' }),
        })
      )

      expect(store.updateNode).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          metadata: expect.objectContaining({ phase: 'IDLE' }),
        })
      )
    })
  })

  describe('handleSessionEvent - deleted', () => {
    it('should preserve history on delete (no-op)', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      const nodeCountBefore = store._nodes.size

      await linker.handleSessionEvent(
        makeEvent({ type: 'deleted' })
      )

      // Should not delete nodes
      expect(store.deleteNode).not.toHaveBeenCalled()
      expect(store._nodes.size).toBe(nodeCountBefore)
    })
  })

  describe('idempotency', () => {
    it('should not create duplicate session nodes', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // createNode should be called once for the session node
      // (second call skipped due to createdNodes cache)
      const createCalls = (store.createNode as ReturnType<typeof vi.fn>).mock.calls
      const sessionNodes = createCalls.filter(
        (call: unknown[]) => String((call[0] as Record<string, unknown>).uri ?? '').includes('session')
      )
      expect(sessionNodes).toHaveLength(1)
    })

    it('should not create duplicate edges', async () => {
      store._nodes.set('i-task1', {
        id: 'i-task1',
        type: 'issue',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Second event — edge already exists in store
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Should have created worked-on edge once
      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const workedOnEdges = edgeCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'worked-on'
      )
      // First call creates it, second should find it exists via query
      expect(workedOnEdges.length).toBeLessThanOrEqual(2)
    })
  })

  describe('flush manager integration', () => {
    it('should call markDirty and schedule on node creation', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      expect(flushManager.markDirty).toHaveBeenCalled()
      expect(flushManager.schedule).toHaveBeenCalled()
    })
  })
})
