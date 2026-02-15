/**
 * Tests for Tools Method Handlers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerToolsMethods } from '../tools.js'
import type { IPCServer } from '../../ipc.js'
import type { DaemonFlushManager } from '../../flush.js'
import type { GraphStore } from '../../../graph/store.js'
import type { LocationResolver, LocationState } from '../../location-state.js'

// ============================================================================
// Mocks
// ============================================================================

function createMockServer() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>()

  return {
    handle: vi.fn((method: string, handler: (params: unknown) => Promise<unknown>) => {
      handlers.set(method, handler)
    }),
    call: async (method: string, params?: unknown) => {
      const handler = handlers.get(method)
      if (!handler) {
        throw new Error(`Method not found: ${method}`)
      }
      return handler(params)
    },
    handlers,
  } as unknown as IPCServer & { call: (method: string, params?: unknown) => Promise<unknown>; handlers: Map<string, (params: unknown) => Promise<unknown>> }
}

function createMockFlushManager() {
  return {
    markDirty: vi.fn(),
    schedule: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaemonFlushManager
}

function createMockStore() {
  const nodes = new Map<string, { id: string; type: string; title: string; content?: string }>()
  const edges = new Map<string, { id: string; from_id: string; to_id: string; type: string }>()

  return {
    query: {
      nodes: vi.fn().mockResolvedValue([]),
      edges: vi.fn().mockResolvedValue([]),
      ready: vi.fn().mockResolvedValue([]),
      blockers: vi.fn().mockResolvedValue([]),
      blocking: vi.fn().mockResolvedValue([]),
      feedback: vi.fn().mockResolvedValue([]),
      tasks: vi.fn().mockResolvedValue([]),
      context: vi.fn().mockResolvedValue([]),
    },
    getNode: vi.fn((id: string) => Promise.resolve(nodes.get(id) ?? null)),
    getEdge: vi.fn((id: string) => Promise.resolve(edges.get(id) ?? null)),
    createNode: vi.fn((input: { type: string; title: string }) => {
      const prefix = input.type === 'feedback' ? 'f' : input.type.charAt(0)
      const node = { id: `${prefix}-1`, ...input }
      nodes.set(node.id, node)
      return Promise.resolve(node)
    }),
    updateNode: vi.fn((id: string, updates: Record<string, unknown>) => {
      const node = nodes.get(id)
      if (!node) {
        throw new Error(`Node not found: ${id}`)
      }
      const updated = { ...node, ...updates }
      nodes.set(id, updated)
      return Promise.resolve(updated)
    }),
    deleteNode: vi.fn((id: string) => {
      if (!nodes.has(id)) {
        throw new Error(`Node not found: ${id}`)
      }
      nodes.delete(id)
      return Promise.resolve()
    }),
    createEdge: vi.fn((input: { from_id: string; to_id: string; type: string }) => {
      const edge = { id: `e-1`, ...input }
      edges.set(edge.id, edge)
      return Promise.resolve(edge)
    }),
    deleteEdge: vi.fn((id: string) => {
      if (!edges.has(id)) {
        throw new Error(`Edge not found: ${id}`)
      }
      edges.delete(id)
      return Promise.resolve()
    }),
    _nodes: nodes,
    _edges: edges,
  } as unknown as GraphStore & {
    _nodes: Map<string, unknown>
    _edges: Map<string, unknown>
  }
}

// ============================================================================
// Tests
// ============================================================================

function createMockLocationResolver(store: ReturnType<typeof createMockStore>, flushManager: ReturnType<typeof createMockFlushManager>): LocationResolver {
  const state = {
    hash: 'primary',
    opentasksPath: '/tmp/.opentasks',
    store: store as unknown as GraphStore,
    flushManager: flushManager as unknown as DaemonFlushManager,
    watcher: {} as any,
    primary: true,
    healthy: true,
  } as LocationState
  return {
    resolve: () => state,
    getDefault: () => state,
    list: () => [{ hash: 'primary', opentasksPath: '/tmp/.opentasks', primary: true, healthy: true }],
    has: () => true,
    add: () => {},
    remove: async () => {},
  }
}

describe('registerToolsMethods', () => {
  let server: ReturnType<typeof createMockServer>
  let store: ReturnType<typeof createMockStore>
  let flushManager: ReturnType<typeof createMockFlushManager>

  beforeEach(() => {
    server = createMockServer()
    store = createMockStore()
    flushManager = createMockFlushManager()

    const locationResolver = createMockLocationResolver(store, flushManager)
    registerToolsMethods({ server, locationResolver })
  })

  describe('tools.link', () => {
    it('should register handler', () => {
      expect(server.handlers.has('tools.link')).toBe(true)
    })

    it('should create edge between local nodes', async () => {
      // Set up nodes
      store._nodes.set('t-1', { id: 't-1', type: 'task', title: 'Task 1' })
      store._nodes.set('t-2', { id: 't-2', type: 'task', title: 'Task 2' })
      store.getNode = vi.fn((id: string) => Promise.resolve(store._nodes.get(id) ?? null)) as any

      const result = await server.call('tools.link', {
        fromId: 't-1',
        toId: 't-2',
        type: 'blocks',
      })

      expect(result).toHaveProperty('success', true)
      expect(result).toHaveProperty('edgeId')
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-1')
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-2')
      expect(flushManager.schedule).toHaveBeenCalled()
    })

    it('should return error if params is undefined', async () => {
      const result = await server.call('tools.link', undefined)

      expect(result).toEqual({
        success: false,
        error: 'Missing required parameters',
      })
    })

    it('should return error for missing fromId', async () => {
      const result = await server.call('tools.link', {
        toId: 't-2',
        type: 'blocks',
      })

      expect(result).toHaveProperty('success', false)
      expect(result).toHaveProperty('error')
    })

    it('should not mark dirty for provider URIs', async () => {
      // Provider URI doesn't match local ID pattern
      const result = await server.call('tools.link', {
        fromId: 'beads://./test',
        toId: 'jira://PROJ-123',
        type: 'blocks',
      })

      // Should succeed but not mark dirty (URIs don't match local pattern)
      expect(result).toHaveProperty('success', true)
      expect(flushManager.markDirty).not.toHaveBeenCalled()
    })
  })

  describe('tools.query', () => {
    it('should register handler', () => {
      expect(server.handlers.has('tools.query')).toBe(true)
    })

    it('should query nodes', async () => {
      ;(store.query.nodes as any).mockResolvedValue([
        { id: 't-1', type: 'task', title: 'Test', archived: false },
      ])

      const result = await server.call('tools.query', {
        nodes: { type: 'task' },
      })

      expect(result).toHaveProperty('items')
      expect(result).toHaveProperty('hasMore')
      expect(store.query.nodes).toHaveBeenCalled()
    })

    it('should query ready items', async () => {
      ;(store.query.ready as any).mockResolvedValue([
        { id: 't-1', type: 'task', title: 'Ready Task', archived: false },
      ])

      const result = await server.call('tools.query', {
        ready: {},
      })

      expect(result).toHaveProperty('items')
      expect(store.query.ready).toHaveBeenCalled()
    })

    it('should throw error if params is undefined', async () => {
      await expect(server.call('tools.query', undefined)).rejects.toThrow(
        'Missing required parameters'
      )
    })

    it('should throw error if no query type specified', async () => {
      await expect(server.call('tools.query', {})).rejects.toThrow(
        'No query type specified'
      )
    })
  })

  describe('tools.annotate', () => {
    it('should register handler', () => {
      expect(server.handlers.has('tools.annotate')).toBe(true)
    })

    it('should create feedback on target node', async () => {
      // Set up target node
      store._nodes.set('c-1', { id: 'c-1', type: 'context', title: 'Test Context' })
      store.getNode = vi.fn((id: string) => Promise.resolve(store._nodes.get(id) ?? null)) as any

      const result = await server.call('tools.annotate', {
        targetId: 'c-1',
        create: {
          content: 'This is feedback',
          type: 'comment',
        },
      })

      expect(result).toHaveProperty('success', true)
      expect(result).toHaveProperty('feedbackId')
      expect(store.createNode).toHaveBeenCalled()
      expect(flushManager.markDirty).toHaveBeenCalledWith('c-1')
      expect(flushManager.schedule).toHaveBeenCalled()
    })

    it('should return error if params is undefined', async () => {
      const result = await server.call('tools.annotate', undefined)

      expect(result).toEqual({
        success: false,
        error: 'Missing required parameters',
      })
    })

    it('should return error if targetId is missing', async () => {
      const result = await server.call('tools.annotate', {
        create: { content: 'Test' },
      })

      expect(result).toHaveProperty('success', false)
      expect(result).toHaveProperty('error', 'Missing required parameter: targetId')
    })

    it('should return error if target node not found', async () => {
      store.getNode = vi.fn().mockResolvedValue(null) as any

      const result = await server.call('tools.annotate', {
        targetId: 'nonexistent',
        create: { content: 'Test' },
      })

      expect(result).toHaveProperty('success', false)
      expect(result).toHaveProperty('error')
    })

    it('should resolve feedback', async () => {
      // Set up feedback node
      store._nodes.set('f-1', {
        id: 'f-1',
        type: 'feedback',
        title: 'Feedback',
        resolved: false,
      })
      store.getNode = vi.fn((id: string) => Promise.resolve(store._nodes.get(id) ?? null)) as any

      const result = await server.call('tools.annotate', {
        targetId: 'f-1',
        resolve: 'f-1',
      })

      expect(result).toHaveProperty('success', true)
      expect(store.updateNode).toHaveBeenCalledWith('f-1', { resolved: true })
    })

    it('should dismiss feedback', async () => {
      // Set up feedback node
      store._nodes.set('f-1', {
        id: 'f-1',
        type: 'feedback',
        title: 'Feedback',
        dismissed: false,
      })
      store.getNode = vi.fn((id: string) => Promise.resolve(store._nodes.get(id) ?? null)) as any

      const result = await server.call('tools.annotate', {
        targetId: 'f-1',
        dismiss: 'f-1',
      })

      expect(result).toHaveProperty('success', true)
      expect(store.updateNode).toHaveBeenCalledWith('f-1', { dismissed: true })
    })

    it('should mark fromId dirty when provided', async () => {
      // Set up nodes
      store._nodes.set('c-1', { id: 'c-1', type: 'context', title: 'Test Context' })
      store._nodes.set('t-1', { id: 't-1', type: 'task', title: 'Test Task' })
      store.getNode = vi.fn((id: string) => Promise.resolve(store._nodes.get(id) ?? null)) as any

      const result = await server.call('tools.annotate', {
        targetId: 'c-1',
        fromId: 't-1',
        create: {
          content: 'Feedback from task',
          type: 'suggestion',
        },
      })

      expect(result).toHaveProperty('success', true)
      expect(flushManager.markDirty).toHaveBeenCalledWith('c-1')
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-1')
    })
  })
})
