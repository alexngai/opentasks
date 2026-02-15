/**
 * Tests for Graph Method Handlers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerGraphMethods } from '../graph.js'
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
  const nodes = new Map<string, { id: string; type: string; title: string }>()
  const edges = new Map<string, { id: string; from_id: string; to_id: string; type: string }>()

  return {
    query: {
      nodes: vi.fn().mockResolvedValue([]),
      edges: vi.fn().mockResolvedValue([]),
    },
    getNode: vi.fn((id: string) => Promise.resolve(nodes.get(id) ?? null)),
    getEdge: vi.fn((id: string) => Promise.resolve(edges.get(id) ?? null)),
    createNode: vi.fn((input: { type: string; title: string }) => {
      const node = { id: `${input.type.charAt(0)}-1`, ...input }
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
  } as unknown as GraphStore & { _nodes: Map<string, unknown>; _edges: Map<string, unknown> }
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

describe('registerGraphMethods', () => {
  let server: ReturnType<typeof createMockServer>
  let store: ReturnType<typeof createMockStore>
  let flushManager: ReturnType<typeof createMockFlushManager>

  beforeEach(() => {
    server = createMockServer()
    store = createMockStore()
    flushManager = createMockFlushManager()

    const locationResolver = createMockLocationResolver(store, flushManager)
    registerGraphMethods({ server, locationResolver })
  })

  describe('graph.query', () => {
    it('should register handler', () => {
      expect(server.handlers.has('graph.query')).toBe(true)
    })

    it('should call store.query.nodes with filter', async () => {
      const filter = { type: 'task' as const, status: 'open' }
      await server.call('graph.query', { filter, limit: 10, offset: 0 })

      expect(store.query.nodes).toHaveBeenCalledWith({
        ...filter,
        limit: 10,
        offset: 0,
      })
    })

    it('should handle empty params', async () => {
      await server.call('graph.query', {})

      expect(store.query.nodes).toHaveBeenCalledWith({
        limit: undefined,
        offset: undefined,
      })
    })

    it('should add type to filter if provided', async () => {
      await server.call('graph.query', { type: 'context' })

      expect(store.query.nodes).toHaveBeenCalledWith({
        type: 'context',
        limit: undefined,
        offset: undefined,
      })
    })
  })

  describe('graph.get', () => {
    it('should register handler', () => {
      expect(server.handlers.has('graph.get')).toBe(true)
    })

    it('should return node by ID', async () => {
      const node = { id: 't-1', type: 'task', title: 'Test' }
      store._nodes.set('t-1', node)
      store.getNode = vi.fn().mockResolvedValue(node)

      const result = await server.call('graph.get', { id: 't-1' })

      expect(result).toEqual(node)
      expect(store.getNode).toHaveBeenCalledWith('t-1')
    })

    it('should throw error if id is missing', async () => {
      await expect(server.call('graph.get', {})).rejects.toThrow(
        'Missing required parameter: id'
      )
    })

    it('should throw error if params is undefined', async () => {
      await expect(server.call('graph.get', undefined)).rejects.toThrow(
        'Missing required parameter: id'
      )
    })
  })

  describe('graph.create', () => {
    it('should register handler', () => {
      expect(server.handlers.has('graph.create')).toBe(true)
    })

    it('should create node and mark dirty', async () => {
      const input = { type: 'task' as const, title: 'Test Task' }

      const result = await server.call('graph.create', input)

      expect(store.createNode).toHaveBeenCalledWith(input)
      expect(flushManager.markDirty).toHaveBeenCalled()
      expect(flushManager.schedule).toHaveBeenCalled()
      expect(result).toHaveProperty('id')
    })

    it('should throw error if params is undefined', async () => {
      await expect(server.call('graph.create', undefined)).rejects.toThrow(
        'Missing required parameters'
      )
    })
  })

  describe('graph.update', () => {
    it('should register handler', () => {
      expect(server.handlers.has('graph.update')).toBe(true)
    })

    it('should update node and mark dirty', async () => {
      const node = { id: 't-1', type: 'task', title: 'Test' }
      store._nodes.set('t-1', node)

      await server.call('graph.update', { id: 't-1', title: 'Updated' })

      expect(store.updateNode).toHaveBeenCalledWith('t-1', { title: 'Updated' })
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-1')
      expect(flushManager.schedule).toHaveBeenCalled()
    })

    it('should throw error if id is missing', async () => {
      await expect(server.call('graph.update', { title: 'Test' })).rejects.toThrow(
        'Missing required parameter: id'
      )
    })

    it('should throw error if params is undefined', async () => {
      await expect(server.call('graph.update', undefined)).rejects.toThrow(
        'Missing required parameter: id'
      )
    })
  })

  describe('graph.delete', () => {
    it('should register handler', () => {
      expect(server.handlers.has('graph.delete')).toBe(true)
    })

    it('should delete node and mark dirty', async () => {
      const node = { id: 't-1', type: 'task', title: 'Test' }
      store._nodes.set('t-1', node)

      await server.call('graph.delete', { id: 't-1' })

      expect(store.deleteNode).toHaveBeenCalledWith('t-1', undefined)
      expect(flushManager.markDirty).toHaveBeenCalledWith('__deleted__:i-1')
      expect(flushManager.schedule).toHaveBeenCalled()
    })

    it('should pass options when provided', async () => {
      const node = { id: 't-1', type: 'task', title: 'Test' }
      store._nodes.set('t-1', node)

      await server.call('graph.delete', { id: 't-1', options: { hard: true } })

      expect(store.deleteNode).toHaveBeenCalledWith('t-1', { hard: true })
    })

    it('should throw error if id is missing', async () => {
      await expect(server.call('graph.delete', {})).rejects.toThrow(
        'Missing required parameter: id'
      )
    })
  })

  describe('graph.createEdge', () => {
    it('should register handler', () => {
      expect(server.handlers.has('graph.createEdge')).toBe(true)
    })

    it('should create edge and mark both nodes dirty', async () => {
      const input = { from_id: 't-1', to_id: 't-2', type: 'blocks' as const }

      const result = await server.call('graph.createEdge', input)

      expect(store.createEdge).toHaveBeenCalledWith({
        from_id: 't-1',
        to_id: 't-2',
        type: 'blocks',
        metadata: undefined,
      })
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-1')
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-2')
      expect(flushManager.schedule).toHaveBeenCalled()
      expect(result).toHaveProperty('id')
    })

    it('should throw error if params is undefined', async () => {
      await expect(server.call('graph.createEdge', undefined)).rejects.toThrow(
        'Missing required parameters'
      )
    })
  })

  describe('graph.deleteEdge', () => {
    it('should register handler', () => {
      expect(server.handlers.has('graph.deleteEdge')).toBe(true)
    })

    it('should delete edge and mark both nodes dirty', async () => {
      const edge = { id: 'e-1', from_id: 't-1', to_id: 't-2', type: 'blocks' }
      store._edges.set('e-1', edge)
      store.getEdge = vi.fn().mockResolvedValue(edge)

      await server.call('graph.deleteEdge', { id: 'e-1' })

      expect(store.deleteEdge).toHaveBeenCalledWith('e-1')
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-1')
      expect(flushManager.markDirty).toHaveBeenCalledWith('t-2')
      expect(flushManager.schedule).toHaveBeenCalled()
    })

    it('should not mark dirty if edge did not exist', async () => {
      store.getEdge = vi.fn().mockResolvedValue(null)
      store.deleteEdge = vi.fn().mockResolvedValue(undefined)

      await server.call('graph.deleteEdge', { id: 'nonexistent' })

      expect(flushManager.markDirty).not.toHaveBeenCalled()
    })

    it('should throw error if id is missing', async () => {
      await expect(server.call('graph.deleteEdge', {})).rejects.toThrow(
        'Missing required parameter: id'
      )
    })
  })

  describe('flush', () => {
    it('should register handler', () => {
      expect(server.handlers.has('flush')).toBe(true)
    })

    it('should call flushManager.flush', async () => {
      const result = await server.call('flush')

      expect(flushManager.flush).toHaveBeenCalled()
      expect(result).toEqual({ success: true })
    })
  })
})
