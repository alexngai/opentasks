/**
 * Tests for Entire Auto-Linker
 *
 * Verifies:
 * - Correct session/checkpoint node creation in the graph store
 * - Edges use actual node IDs (not URIs) for from_id/to_id
 * - Three-tier correlation: claimed tasks, branch match, single in-progress
 * - Confidence threshold filtering
 * - Ambiguity guard for low-confidence matches
 * - Idempotency of node and edge creation
 * - Event handling for started, checkpoint, ended, updated, deleted
 * - Flush manager integration
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
      const id = `x-mock${nextNodeId++}`
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
      const id = `e-mock${nextEdgeId++}`
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

    it('should use actual node ID (not URI) for edge creation', async () => {
      // Add a claimed in-progress task
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'claude-agent-1',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // The session node should be created with a mock ID like 'x-mock1'
      const createNodeCalls = (store.createNode as ReturnType<typeof vi.fn>).mock.calls
      const sessionNodeCall = createNodeCalls.find(
        (call: unknown[]) => String((call[0] as Record<string, unknown>).uri ?? '').includes('session')
      )
      expect(sessionNodeCall).toBeDefined()

      // The edge should use the actual node ID, NOT the URI
      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 't-task1',
          to_id: expect.stringMatching(/^x-mock\d+$/), // Should be the graph ID, not a URI
          type: 'worked-on',
        })
      )
    })

    it('should create worked-on edge when claimed task exists', async () => {
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'claude-agent-1',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 't-task1',
          type: 'worked-on',
        })
      )
    })

    it('should create worked-on edge for in-progress tasks on same branch', async () => {
      store._nodes.set('t-branch', {
        id: 't-branch',
        type: 'task',
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
          from_id: 't-branch',
          type: 'worked-on',
        })
      )
    })

    it('should create worked-on edge for single in-progress task (fallback)', async () => {
      store._nodes.set('t-only', {
        id: 't-only',
        type: 'task',
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
          from_id: 't-only',
          type: 'worked-on',
        })
      )
    })

    it('should NOT create edges for ambiguous low-confidence matches', async () => {
      // Two in-progress tasks, no claims, no branch match
      store._nodes.set('t-one', {
        id: 't-one',
        type: 'task',
        status: 'in_progress',
        archived: false,
      })
      store._nodes.set('t-two', {
        id: 't-two',
        type: 'task',
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
      store._nodes.set('t-only', {
        id: 't-only',
        type: 'task',
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

    it('should allow medium confidence when threshold is medium', async () => {
      // In-progress task on same branch = medium confidence
      store._nodes.set('t-branch', {
        id: 't-branch',
        type: 'task',
        status: 'in_progress',
        archived: false,
        branch: 'feature/auth',
      })

      // Default minConfidence is 'medium'
      await linker.handleSessionEvent(
        makeEvent({
          type: 'started',
          session: makeSession({ branch: 'feature/auth' }),
        })
      )

      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const workedOnEdges = edgeCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'worked-on'
      )
      expect(workedOnEdges).toHaveLength(1)
    })

    it('should prefer claimed-task strategy over branch match', async () => {
      // Both a claimed task AND a branch-matching task exist
      store._nodes.set('t-claimed', {
        id: 't-claimed',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent-1',
        lock_until: new Date(Date.now() + 60000).toISOString(),
        branch: 'other-branch',
      })
      store._nodes.set('t-branch', {
        id: 't-branch',
        type: 'task',
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

      // Should only link to the claimed task (strategy 1 wins)
      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const workedOnEdges = edgeCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'worked-on'
      )
      expect(workedOnEdges).toHaveLength(1)
      expect((workedOnEdges[0][0] as Record<string, unknown>).from_id).toBe('t-claimed')
    })

    it('should ignore expired lock_until claims', async () => {
      // Claimed task with expired lock
      store._nodes.set('t-expired', {
        id: 't-expired',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent-1',
        lock_until: new Date(Date.now() - 60000).toISOString(), // Expired
      })

      // Also add a branch-matching task
      store._nodes.set('t-branch', {
        id: 't-branch',
        type: 'task',
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

      // Should NOT use the expired claim, should fall through to branch match
      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const workedOnEdges = edgeCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'worked-on'
      )
      expect(workedOnEdges).toHaveLength(1)
      expect((workedOnEdges[0][0] as Record<string, unknown>).from_id).toBe('t-branch')
    })

    it('should store correlation results', async () => {
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
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
      expect(result.strategy).toBe('claimed-task')
    })

    it('should store correlation with strategy none when no tasks matched', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      const correlations = linker.getCorrelations()
      const result = correlations.get('2026-02-13-test')!
      expect(result.matchedTasks).toHaveLength(0)
      expect(result.strategy).toBe('none')
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

      // Should create contains edge (session node ID → checkpoint node ID)
      expect(store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: expect.stringMatching(/^x-mock\d+$/),
          to_id: expect.stringMatching(/^x-mock\d+$/),
          type: 'contains',
        })
      )
    })

    it('should use actual node IDs (not URIs) for contains edge', async () => {
      await linker.handleSessionEvent(
        makeEvent({
          type: 'checkpoint',
          checkpointId: 'cp-001',
          session: makeSession({ checkpoints: ['cp-001'] }),
        })
      )

      // Get the contains edge call
      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const containsEdge = edgeCalls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'contains'
      )
      expect(containsEdge).toBeDefined()

      const edgeInput = containsEdge![0] as Record<string, unknown>
      // Neither from_id nor to_id should be a URI
      expect(edgeInput.from_id).not.toContain('entire://')
      expect(edgeInput.to_id).not.toContain('entire://')
      // Both should be valid mock node IDs
      expect(edgeInput.from_id).toMatch(/^x-mock\d+$/)
      expect(edgeInput.to_id).toMatch(/^x-mock\d+$/)
    })

    it('should create implemented-by edges for correlated tasks', async () => {
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
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
          from_id: 't-task1',
          to_id: expect.stringMatching(/^x-mock\d+$/), // checkpoint node ID
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

    it('should create both session and checkpoint nodes on checkpoint event', async () => {
      await linker.handleSessionEvent(
        makeEvent({
          type: 'checkpoint',
          checkpointId: 'cp-001',
          session: makeSession({ checkpoints: ['cp-001'] }),
        })
      )

      // Should create both a session node and a checkpoint node
      const createCalls = (store.createNode as ReturnType<typeof vi.fn>).mock.calls
      expect(createCalls).toHaveLength(2)

      const uris = createCalls.map(
        (call: unknown[]) => (call[0] as Record<string, unknown>).uri
      )
      expect(uris).toContain('entire://session/2026-02-13-test')
      expect(uris).toContain('entire://checkpoint/cp-001')
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

    it('should include endedAt in metadata update', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      await linker.handleSessionEvent(
        makeEvent({
          type: 'ended',
          session: makeSession({ phase: 'ENDED', endedAt: '2026-02-13T16:00:00Z' }),
        })
      )

      expect(store.updateNode).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          metadata: expect.objectContaining({
            phase: 'ENDED',
            endedAt: '2026-02-13T16:00:00Z',
          }),
        })
      )
    })

    it('should be a no-op when session node does not exist', async () => {
      // Don't create session first — just try to end it
      await linker.handleSessionEvent(
        makeEvent({
          type: 'ended',
          session: makeSession({ phase: 'ENDED' }),
        })
      )

      expect(store.updateNode).not.toHaveBeenCalled()
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

    it('should include lastPromptAt in metadata', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      await linker.handleSessionEvent(
        makeEvent({
          type: 'updated',
          session: makeSession({ lastPromptAt: '2026-02-13T15:30:00Z' }),
        })
      )

      expect(store.updateNode).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          metadata: expect.objectContaining({
            lastPromptAt: '2026-02-13T15:30:00Z',
          }),
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
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Second event — edge already exists in store
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Should have created worked-on edge only once
      // (second call finds existing via query)
      const edgeCalls = (store.createEdge as ReturnType<typeof vi.fn>).mock.calls
      const workedOnEdges = edgeCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === 'worked-on'
      )
      expect(workedOnEdges).toHaveLength(1)
    })

    it('should not create duplicate checkpoint nodes', async () => {
      const checkpointEvent = makeEvent({
        type: 'checkpoint',
        checkpointId: 'cp-001',
        session: makeSession({ checkpoints: ['cp-001'] }),
      })

      await linker.handleSessionEvent(checkpointEvent)
      await linker.handleSessionEvent(checkpointEvent)

      const createCalls = (store.createNode as ReturnType<typeof vi.fn>).mock.calls
      const checkpointNodes = createCalls.filter(
        (call: unknown[]) => String((call[0] as Record<string, unknown>).uri ?? '').includes('checkpoint')
      )
      expect(checkpointNodes).toHaveLength(1)
    })
  })

  describe('flush manager integration', () => {
    it('should call markDirty and schedule on node creation', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      expect(flushManager.markDirty).toHaveBeenCalled()
      expect(flushManager.schedule).toHaveBeenCalled()
    })

    it('should call markDirty with the actual node ID', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // markDirty should be called with an actual node ID, not a URI
      const markDirtyCalls = (flushManager.markDirty as ReturnType<typeof vi.fn>).mock.calls
      const dirtyIds = markDirtyCalls.map((call: unknown[]) => call[0] as string)

      for (const id of dirtyIds) {
        expect(id).toMatch(/^x-mock\d+$/)
        expect(id).not.toContain('entire://')
      }
    })

    it('should call markDirty and schedule on edge creation', async () => {
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Should have been called for both the node and the edge endpoints
      expect((flushManager.markDirty as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
      expect((flushManager.schedule as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
    })

    it('should call markDirty and schedule on session update', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))
      ;(flushManager.markDirty as ReturnType<typeof vi.fn>).mockClear()
      ;(flushManager.schedule as ReturnType<typeof vi.fn>).mockClear()

      await linker.handleSessionEvent(
        makeEvent({
          type: 'updated',
          session: makeSession({ phase: 'IDLE' }),
        })
      )

      expect(flushManager.markDirty).toHaveBeenCalled()
      expect(flushManager.schedule).toHaveBeenCalled()
    })
  })

  describe('correlation results', () => {
    it('should return a copy of correlations (not the internal map)', async () => {
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      const correlations1 = linker.getCorrelations()
      const correlations2 = linker.getCorrelations()

      // Should be different Map instances
      expect(correlations1).not.toBe(correlations2)
      // But same content
      expect(correlations1.size).toBe(correlations2.size)
    })

    it('should track nodes created across started and checkpoint events', async () => {
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      // Started event creates session node
      await linker.handleSessionEvent(makeEvent({ type: 'started' }))

      // Checkpoint event creates checkpoint node and adds to existing correlation
      await linker.handleSessionEvent(
        makeEvent({
          type: 'checkpoint',
          checkpointId: 'cp-001',
          session: makeSession({ checkpoints: ['cp-001'] }),
        })
      )

      const correlations = linker.getCorrelations()
      const result = correlations.get('2026-02-13-test')!
      expect(result.nodesCreated.length).toBeGreaterThanOrEqual(2) // session + checkpoint
      expect(result.edgesCreated.length).toBeGreaterThanOrEqual(2) // worked-on + contains + implemented-by
    })
  })

  describe('correlate (manual trigger)', () => {
    it('should create session node and correlate with tasks', async () => {
      store._nodes.set('t-task1', {
        id: 't-task1',
        type: 'task',
        status: 'in_progress',
        archived: false,
        claimed_by: 'agent',
        lock_until: new Date(Date.now() + 60000).toISOString(),
      })

      const session = makeSession()
      const result = await linker.correlate('2026-02-13-test', session)

      expect(result.sessionId).toBe('2026-02-13-test')
      expect(result.matchedTasks).toHaveLength(1)
      expect(result.matchedTasks[0].matchReason).toBe('claimed-task')
      expect(result.nodesCreated).toHaveLength(1)
      expect(result.edgesCreated.length).toBeGreaterThanOrEqual(1)
      expect(result.strategy).toBe('claimed-task')
    })

    it('should return result with strategy none when no tasks matched', async () => {
      const session = makeSession()
      const result = await linker.correlate('2026-02-13-test', session)

      expect(result.matchedTasks).toHaveLength(0)
      expect(result.strategy).toBe('none')
      expect(result.nodesCreated).toHaveLength(1) // session node still created
    })

    it('should store correlation result in history', async () => {
      const session = makeSession()
      await linker.correlate('2026-02-13-test', session)

      const correlations = linker.getCorrelations()
      expect(correlations.has('2026-02-13-test')).toBe(true)
    })

    it('should be idempotent (same as handleSessionEvent)', async () => {
      const session = makeSession()
      await linker.correlate('2026-02-13-test', session)
      await linker.correlate('2026-02-13-test', session)

      // Should only create one session node
      const createCalls = (store.createNode as ReturnType<typeof vi.fn>).mock.calls
      expect(createCalls).toHaveLength(1)
    })
  })
})
